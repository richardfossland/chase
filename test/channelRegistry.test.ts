import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RealtimeChannel } from "@supabase/supabase-js";
import {
  acquireChannel,
  sendOnTopic,
  __setChannelDriver,
  __entryCount,
} from "@/lib/client/channelRegistry";

// A minimal stand-in for RealtimeChannel: records handlers, lets a test emit a
// broadcast or a status, and counts sends/tracks.
interface Fake {
  topic: string;
  state: string;
  sent: unknown[];
  emit: (event: string, payload: Record<string, unknown>) => void;
  status: (s: string) => void;
  track: ReturnType<typeof vi.fn>;
  untrack: ReturnType<typeof vi.fn>;
}
function fakeChannel(topic: string): Fake & RealtimeChannel {
  const broadcast: ((m: { event: string; payload: unknown }) => void)[] = [];
  let statusCb: ((s: string) => void) | undefined;
  const f = {
    topic,
    state: "closed",
    sent: [] as unknown[],
    on(type: string, _filter: unknown, cb: (m: { event: string; payload: unknown }) => void) {
      if (type === "broadcast") broadcast.push(cb);
      return f;
    },
    subscribe(cb?: (s: string) => void) {
      statusCb = cb;
      f.state = "joined";
      cb?.("SUBSCRIBED");
      return f;
    },
    send(msg: unknown) {
      f.sent.push(msg);
      return Promise.resolve("ok");
    },
    track: vi.fn(async () => "ok"),
    untrack: vi.fn(async () => "ok"),
    presenceState: () => ({}),
    emit(event: string, payload: Record<string, unknown>) {
      for (const cb of broadcast) cb({ event, payload });
    },
    status(s: string) {
      statusCb?.(s);
    },
  };
  return f as unknown as Fake & RealtimeChannel;
}

let created: (Fake & RealtimeChannel)[] = [];
let removed: unknown[] = [];

beforeEach(() => {
  created = [];
  removed = [];
  __setChannelDriver({
    create: (topic) => {
      const c = fakeChannel(topic);
      created.push(c);
      return c;
    },
    remove: (c) => {
      removed.push(c);
    },
  });
});
afterEach(() => {
  __setChannelDriver(null);
  vi.useRealTimers();
});

const flush = () => new Promise<void>((r) => queueMicrotask(r));

describe("channelRegistry", () => {
  it("shares one channel per topic and fans a broadcast out to every subscriber", () => {
    const a = vi.fn();
    const b = vi.fn();
    acquireChannel("t:1", { onBroadcast: a });
    acquireChannel("t:1", { onBroadcast: b });
    expect(created).toHaveLength(1);
    created[0].emit("match_updated", { matchId: "m" });
    expect(a).toHaveBeenCalledWith("match_updated", { matchId: "m" });
    expect(b).toHaveBeenCalledWith("match_updated", { matchId: "m" });
  });

  it("keeps the channel while any subscriber remains; tears down after the last release", async () => {
    const s1 = acquireChannel("t:2", {});
    const s2 = acquireChannel("t:2", {});
    s1.release();
    await flush();
    expect(removed).toHaveLength(0);
    s2.release();
    await flush();
    expect(removed).toHaveLength(1);
    expect(__entryCount()).toBe(0);
  });

  it("a synchronous release→re-acquire reuses the live channel (StrictMode remount)", async () => {
    const s1 = acquireChannel("t:3", {});
    s1.release();
    acquireChannel("t:3", {}); // same tick, before the deferred teardown
    await flush();
    expect(removed).toHaveLength(0);
    expect(created).toHaveLength(1);
  });

  it("recreates a CLOSED channel with backoff and re-binds subscribers", () => {
    vi.useFakeTimers();
    const onEvent = vi.fn();
    const onStatus = vi.fn();
    acquireChannel("t:4", { onBroadcast: onEvent, onStatus });
    created[0].status("CLOSED");
    expect(onStatus).toHaveBeenCalledWith("CLOSED");
    expect(created).toHaveLength(1);
    vi.advanceTimersByTime(999);
    expect(created).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(created).toHaveLength(2);
    expect(removed).toEqual([created[0]]);
    created[1].emit("structure", {});
    expect(onEvent).toHaveBeenCalledWith("structure", {});
    // A late event from the dead channel is ignored.
    onEvent.mockClear();
    created[0].emit("structure", {});
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("backoff grows, and a healthy SUBSCRIBED resets it", () => {
    vi.useFakeTimers();
    acquireChannel("t:5", {});
    created[0].status("CLOSED"); // → 1000
    vi.advanceTimersByTime(1000);
    expect(created).toHaveLength(2);
    // The fake subscribe() reported SUBSCRIBED synchronously → step reset.
    created[1].status("CLOSED"); // → back to 1000, not 2000
    vi.advanceTimersByTime(1000);
    expect(created).toHaveLength(3);
  });

  it("sendOnTopic targets the CURRENT channel after a recreate", () => {
    vi.useFakeTimers();
    acquireChannel("t:6", {});
    created[0].status("TIMED_OUT");
    vi.advanceTimersByTime(1000);
    sendOnTopic("t:6", "reaction", { kind: "clap", n: 2 });
    expect(created[0].sent).toHaveLength(0);
    expect(created[1].sent).toEqual([{ type: "broadcast", event: "reaction", payload: { kind: "clap", n: 2 } }]);
  });

  it("presence: tracks on subscribe and re-tracks after a recreate", () => {
    vi.useFakeTimers();
    acquireChannel("t:7:presence", { track: { key: "dev1", payload: { deviceId: "dev1", name: "Bane 1" } } });
    expect(created[0].track).toHaveBeenCalledWith({ deviceId: "dev1", name: "Bane 1" });
    created[0].status("CLOSED");
    vi.advanceTimersByTime(1000);
    expect(created[1].track).toHaveBeenCalledWith({ deviceId: "dev1", name: "Bane 1" });
  });

  it("releasing the last subscriber cancels a pending recreate", () => {
    vi.useFakeTimers();
    const s = acquireChannel("t:8", {});
    created[0].status("CLOSED");
    s.release();
    vi.advanceTimersByTime(60_000);
    expect(created).toHaveLength(1);
  });
});
