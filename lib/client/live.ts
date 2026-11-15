// Browser client for the session room socket (Durable Objects stage 1, ADR-031).
// No React here. The token travels only in the first frame, never in the URL
// (CLAUDE.md rule 7). Positions are never logged.

import { CLOSE, PING, type ClientMsg, type FixMsg, type ServerMsg } from "@/lib/live/protocol";

export type LiveState = "connecting" | "ready" | "closed" | "disabled";

/** Close codes after which we do not reconnect. `disabled` means HTTP for this page load. */
const TERMINAL = new Set<number>([CLOSE.ended, CLOSE.kicked, CLOSE.not_found, CLOSE.auth, CLOSE.disabled]);
export const isTerminalClose = (code: number): boolean => TERMINAL.has(code);

export const PING_MS = 5000;
export const SILENCE_MS = 7000;
export const BACKOFF_MIN_MS = 500;
export const BACKOFF_MAX_MS = 8000;

/** Reconnect delay for the nth attempt (0-based), before jitter. */
export const backoffMs = (attempt: number): number => Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempt);

/** Minimal WebSocket surface we use (the fake in tests implements this). */
export interface WsLike {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number): void;
}
export type WsCtor = new (url: string) => WsLike;

export interface LiveSocketOpts {
  path: string;
  auth: Extract<ClientMsg, { t: "auth" }>;
  onMsg: (m: ServerMsg) => void;
  /** `code` is set on close; `terminal` when no reconnect will follow. */
  onState?: (state: LiveState, detail?: { code?: number; terminal?: boolean }) => void;
  /** Injected in tests. */
  WebSocketImpl?: WsCtor;
  /** Overrides NEXT_PUBLIC_LIVE_WS_BASE and location (tests). */
  base?: string;
}

/** wss://host (from location) or the dev override, e.g. ws://127.0.0.1:8787. */
export function liveUrl(path: string, base?: string): string {
  const override = base ?? process.env.NEXT_PUBLIC_LIVE_WS_BASE;
  if (override) return override.replace(/\/$/, "") + path;
  const l = location;
  return `${l.protocol === "https:" ? "wss:" : "ws:"}//${l.host}${path}`;
}

const OPEN = 1;

export class LiveSocket {
  state: LiveState = "connecting";
  private ws: WsLike | null = null;
  private attempt = 0;
  private stopped = false;
  private silence: ReturnType<typeof setTimeout> | null = null;
  private pinger: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private readonly opts: LiveSocketOpts;

  constructor(opts: LiveSocketOpts) {
    this.opts = opts;
    if (typeof window !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisible);
      window.addEventListener("online", this.reconnectNow);
    }
    this.connect();
  }

  private set(state: LiveState, detail?: { code?: number; terminal?: boolean }) {
    this.state = state;
    this.opts.onState?.(state, detail);
  }

  private connect() {
    if (this.stopped) return;
    this.clearTimers();
    const Ctor = this.opts.WebSocketImpl ?? (WebSocket as unknown as WsCtor);
    if (this.state !== "connecting") this.set("connecting");
    let ws: WsLike;
    try {
      ws = new Ctor(liveUrl(this.opts.path, this.opts.base));
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      ws.send(JSON.stringify(this.opts.auth)); // token only in this first frame
      this.armSilence();
      this.pinger = setInterval(() => {
        if (ws.readyState === OPEN) ws.send(PING);
      }, PING_MS);
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.armSilence();
      if (typeof ev.data !== "string" || ev.data === "pong") return;
      let m: ServerMsg;
      try {
        m = JSON.parse(ev.data) as ServerMsg;
      } catch {
        return;
      }
      if (m.t === "ready") {
        this.attempt = 0;
        this.set("ready");
      }
      this.opts.onMsg(m);
    };
    ws.onerror = () => {};
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      if (this.stopped) return;
      if (isTerminalClose(ev.code)) {
        this.stopped = true;
        this.detach();
        this.set(ev.code === CLOSE.disabled ? "disabled" : "closed", { code: ev.code, terminal: true });
        return;
      }
      this.set("closed", { code: ev.code, terminal: false });
      this.scheduleRetry();
    };
  }

  private armSilence() {
    if (this.silence) clearTimeout(this.silence);
    this.silence = setTimeout(() => {
      // Nothing (not even a pong) for SILENCE_MS: the link is dead. Drop it and reconnect.
      const ws = this.ws;
      if (!ws) return;
      this.ws = null;
      this.clearTimers();
      try {
        ws.close();
      } catch {
        /* already gone */
      }
      this.set("closed", { terminal: false });
      this.scheduleRetry();
    }, SILENCE_MS);
  }

  private scheduleRetry() {
    if (this.stopped || this.retry) return;
    const delay = backoffMs(this.attempt++) + Math.random() * 250;
    this.retry = setTimeout(() => {
      this.retry = null;
      this.connect();
    }, delay);
  }

  private clearTimers() {
    if (this.silence) clearTimeout(this.silence);
    if (this.pinger) clearInterval(this.pinger);
    if (this.retry) clearTimeout(this.retry);
    this.silence = this.pinger = this.retry = null;
  }

  private reconnectNow = () => {
    if (this.stopped || this.state === "connecting") return;
    if (this.state === "ready") {
      if (this.ws?.readyState === OPEN) this.ws.send(PING); // the silence timer judges the answer
      return;
    }
    this.clearTimers();
    this.connect();
  };

  private onVisible = () => {
    if (document.visibilityState === "visible") this.reconnectNow();
  };

  private detach() {
    if (typeof window === "undefined") return;
    document.removeEventListener("visibilitychange", this.onVisible);
    window.removeEventListener("online", this.reconnectNow);
  }

  /** Send a fix. False when the socket is not open and authenticated. */
  send(fix: Omit<FixMsg, "t">): boolean {
    if (this.state !== "ready" || !this.ws || this.ws.readyState !== OPEN) return false;
    try {
      this.ws.send(JSON.stringify({ t: "fix", ...fix }));
      return true;
    } catch {
      return false;
    }
  }

  close() {
    this.stopped = true;
    this.clearTimers();
    this.detach();
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      /* already gone */
    }
  }
}

/** Per-player fixes must be at least this far apart (the room drops faster ones). */
export const MIN_FIX_GAP_MS = 1900;

/** How long to wait before a fix may go out on the socket (0 = now). */
export function fixDelayMs(now: number, lastSentAt: number | null): number {
  if (lastSentAt === null) return 0;
  return Math.max(0, lastSentAt + MIN_FIX_GAP_MS - now);
}

export const HOST_PUSH_STALE_MS = 6000; // no push for this long: poll fast again
export const HOST_WATCHDOG_MS = 10000; // HTTP poll interval while pushes arrive

/** Should the host's poll timer fetch over HTTP now? */
export function hostPollDue(o: { wsReady: boolean; lastPushAt: number | null; lastHttpAt: number | null; now: number }): boolean {
  const pushing = o.wsReady && o.lastPushAt !== null && o.now - o.lastPushAt < HOST_PUSH_STALE_MS;
  if (!pushing) return true;
  return o.lastHttpAt === null || o.now - o.lastHttpAt >= HOST_WATCHDOG_MS;
}

/** A pushed host view lacks geo (include_geo=false): keep the last full snapshot's geo. */
export function mergeHostPush<T extends object>(prev: T, v: Record<string, unknown>): T {
  const { geo: _geo, live: _live, ...rest } = v;
  void _geo; void _live;
  return { ...prev, ...rest } as T;
}
