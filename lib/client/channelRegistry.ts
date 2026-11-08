"use client";

import type { RealtimeChannel } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";

// One shared, ref-counted Realtime channel per topic, with self-healing.
//
// Why this exists (three separate failure modes, one fix):
//
// 1. supabase-js dedupes channels by topic — `client.channel(topic)` returns
//    the SAME RealtimeChannel for a repeated topic — and `removeChannel` is
//    async. So two hooks on the same page that each "own" the tournament topic
//    (useTournament's listener and the spectator's reaction sender) were
//    really sharing one channel: whichever unmounted first tore it down for
//    the other, and a fast unmount→remount (StrictMode, route change) raced a
//    fresh subscribe against the still-leaving one.
//
// 2. Nothing upstream ever retries a dead channel. A CLOSED / CHANNEL_ERROR /
//    TIMED_OUT (a phone sleeping in a pocket, a gym's flaky wifi, the Realtime
//    server bouncing) meant broadcasts on that topic went silent forever and
//    the screen healed only on the slow poll. The registry recreates the
//    channel with a capped exponential backoff so hints resume on their own.
//
// 3. Presence tracking lives on its own topic but needs the same lifecycle
//    (re-track after a recreate), so it goes through here too.

type BroadcastHandler = (event: string, payload: Record<string, unknown>) => void;
type StatusHandler = (status: string) => void;
type PresenceHandler = (state: Record<string, Record<string, unknown>[]>) => void;

export interface ChannelSub {
  onBroadcast?: BroadcastHandler;
  onStatus?: StatusHandler;
  onPresence?: PresenceHandler;
  /** Advertise presence on this topic: the presence key plus the payload to
   * track. Re-issued automatically after a recreate. Broadcast-only subs omit
   * it. Broadcast and presence never share a topic in this app. */
  track?: { key: string; payload: Record<string, unknown> };
}

interface Entry {
  channel: RealtimeChannel;
  subs: Set<ChannelSub>;
  /** True once the last consumer released; a re-acquire before the deferred
   * teardown runs flips it back and reuses the channel. */
  teardown: boolean;
  topic: string;
  trackKey: string;
  recreateTimer: ReturnType<typeof setTimeout> | null;
  backoffStep: number;
}

const entries = new Map<string, Entry>();

// Capped exponential backoff for channel recreation after CLOSED/error.
const RECREATE_BACKOFF_MS: readonly number[] = [1000, 2000, 5000, 10000, 30000];

function cancelRecreate(entry: Entry): void {
  if (entry.recreateTimer !== null) {
    clearTimeout(entry.recreateTimer);
    entry.recreateTimer = null;
  }
}

function scheduleRecreate(entry: Entry): void {
  if (entry.subs.size === 0 || entry.recreateTimer !== null) return;
  const step = Math.min(entry.backoffStep, RECREATE_BACKOFF_MS.length - 1);
  entry.backoffStep = Math.min(entry.backoffStep + 1, RECREATE_BACKOFF_MS.length - 1);
  entry.recreateTimer = setTimeout(() => {
    entry.recreateTimer = null;
    recreateEntry(entry);
  }, RECREATE_BACKOFF_MS[step]);
}

/** Destroy the dead channel and create+subscribe a fresh one on the SAME topic,
 * re-binding every consumer and re-tracking presence. The Entry object is kept
 * (only `channel` changes) so release() keeps working by topic lookup. */
function recreateEntry(entry: Entry): void {
  if (entry.subs.size === 0) return;
  destroyChannel(entry.channel);
  entry.channel = createChannel(entry.topic, entry.trackKey);
  bindChannel(entry);
}

/** Wire broadcast/presence/status for `entry.channel`, fanning out to every
 * sub. Captures the specific channel and ignores late events from a channel
 * that has since been superseded (e.g. the CLOSED that follows our own
 * destroyChannel call). */
function bindChannel(entry: Entry): void {
  const channel = entry.channel;

  channel.on("broadcast", { event: "*" }, (msg) => {
    if (entry.channel !== channel) return;
    const event = (msg.event as string) ?? "";
    const payload = (msg.payload as Record<string, unknown>) ?? {};
    for (const s of entry.subs) s.onBroadcast?.(event, payload);
  });

  const syncPresence = () => {
    if (entry.channel !== channel) return;
    const state = channel.presenceState() as Record<string, Record<string, unknown>[]>;
    for (const s of entry.subs) s.onPresence?.(state);
  };
  channel.on("presence", { event: "sync" }, syncPresence);
  channel.on("presence", { event: "join" }, syncPresence);
  channel.on("presence", { event: "leave" }, syncPresence);

  channel.subscribe((status) => {
    if (entry.channel !== channel) return;
    for (const s of entry.subs) s.onStatus?.(status);
    if (status === "SUBSCRIBED") {
      cancelRecreate(entry);
      entry.backoffStep = 0;
      for (const s of entry.subs) if (s.track) void channel.track(s.track.payload);
    } else if (status === "CLOSED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
      scheduleRecreate(entry);
    }
  });
}

// Socket-level nudge: one socket per tab, so one listener is enough. The
// moment the tab is foregrounded or the network returns, reconnect immediately
// instead of waiting out realtime-js's own backoff. No-op when connected.
if (typeof window !== "undefined") {
  const nudgeSocket = () => {
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) return;
    const rt = createClient().realtime;
    if (!rt.isConnected()) rt.connect();
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") nudgeSocket();
  });
  window.addEventListener("online", nudgeSocket);
}

// --- test seam: inject a fake channel factory so the lifecycle is unit-testable
// without a live Supabase socket. ---
export interface ChannelDriver {
  create: (topic: string, trackKey: string) => RealtimeChannel;
  remove: (channel: RealtimeChannel) => void;
}
let driver: ChannelDriver | null = null;
export function __setChannelDriver(d: ChannelDriver | null): void {
  driver = d;
  if (!d) entries.clear();
}

function createChannel(topic: string, trackKey: string): RealtimeChannel {
  if (driver) return driver.create(topic, trackKey);
  return createClient().channel(topic, {
    config: { broadcast: { self: false }, presence: { key: trackKey } },
  });
}

function destroyChannel(channel: RealtimeChannel): void {
  if (driver) return driver.remove(channel);
  void createClient().removeChannel(channel);
}

/** Subscribe `sub` to `topic`, sharing one channel per topic. Returns a release
 * fn (call on cleanup). Safe to acquire the same topic from many consumers. */
export function acquireChannel(
  topic: string,
  sub: ChannelSub,
): { channel: RealtimeChannel; release: () => void } {
  const existing = entries.get(topic);
  if (existing) {
    existing.teardown = false;
    existing.subs.add(sub);
    if (sub.onPresence)
      sub.onPresence(
        existing.channel.presenceState() as Record<string, Record<string, unknown>[]>,
      );
    if (sub.track && existing.channel.state === "joined")
      void existing.channel.track(sub.track.payload);
    return { channel: existing.channel, release: () => releaseChannel(topic, sub) };
  }

  const trackKey = sub.track?.key ?? "";
  const entry: Entry = {
    channel: createChannel(topic, trackKey),
    subs: new Set([sub]),
    teardown: false,
    topic,
    trackKey,
    recreateTimer: null,
    backoffStep: 0,
  };
  entries.set(topic, entry);
  bindChannel(entry);
  return { channel: entry.channel, release: () => releaseChannel(topic, sub) };
}

/** Send a broadcast on `topic`'s CURRENT shared channel. Looked up by topic on
 * every call so a send right after a recreate lands on the live channel. A
 * no-op before the first acquire or after the last release. */
export function sendOnTopic(
  topic: string,
  event: string,
  payload: Record<string, unknown>,
): void {
  void entries.get(topic)?.channel.send({ type: "broadcast", event, payload });
}

function releaseChannel(topic: string, sub: ChannelSub): void {
  const entry = entries.get(topic);
  if (!entry) return;
  entry.subs.delete(sub);
  if (sub.track && entry.channel.state === "joined") void entry.channel.untrack();
  if (entry.subs.size > 0) return;
  cancelRecreate(entry);
  // Defer teardown one microtask so a synchronous unmount→remount of the SAME
  // topic reuses the channel instead of racing a fresh subscribe against the
  // still-leaving one.
  entry.teardown = true;
  queueMicrotask(() => {
    const cur = entries.get(topic);
    if (cur && cur.teardown && cur.subs.size === 0) {
      entries.delete(topic);
      destroyChannel(cur.channel);
    }
  });
}

/** Test-only: number of live topic entries. */
export function __entryCount(): number {
  return entries.size;
}
