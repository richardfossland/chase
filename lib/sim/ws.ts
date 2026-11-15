// WebSocket transport for the sim (Durable Objects stage 1, ADR-031). One WsLink
// per bot (and one for the teacher): auth as first frame, reconnect with backoff
// like the real client, terminal close codes stop it, 4003 means "use HTTP".
// Constants mirror lib/live/protocol.ts (inlined: this file also runs in the browser sim).

export const WS_PING = "ping";
export const WS_PONG = "pong";
/** ended, kicked, not found, auth: the bot is done, do not reconnect. */
export const TERMINAL_CODES: ReadonlySet<number> = new Set([4410, 4403, 4404, 4401]);
export const DISABLED_CODE = 4003;
export const BACKOFF_MIN_MS = 500;
export const BACKOFF_MAX_MS = 8000;
const PING_EVERY_MS = 25_000;

/** 0.5 s doubling to 8 s, ±25 % jitter, never above the cap. attempt starts at 0. */
export function reconnectDelayMs(attempt: number, r: () => number): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, attempt));
  return Math.min(BACKOFF_MAX_MS, Math.round(base * (0.75 + 0.5 * r())));
}

/** http(s)://host[:port][/x] → ws(s)://host[:port]. Already-ws URLs keep their origin. */
export function toWsBase(url: string): string {
  const u = new URL(url);
  const proto = u.protocol === "https:" || u.protocol === "wss:" ? "wss:" : "ws:";
  return `${proto}//${u.host}`;
}

export interface WsLike {
  readyState: number;
  send(data: string): void;
  close(code?: number): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type WsCtor = new (url: string) => WsLike;

export type ServerLike = { t: string; v?: Record<string, unknown>; error?: string; [k: string]: unknown };

export interface LinkOptions {
  url: string;
  auth: Record<string, unknown>;
  impl: WsCtor;
  rand: () => number;
  onMessage: (m: ServerLike) => void;
  onState?: (connected: boolean) => void;
  /** Counted when a socket becomes ready again after having been ready before. */
  onReconnect?: () => void;
  onTerminal?: (code: number) => void;
  onDisabled?: () => void;
  onClose?: (code: number) => void;
}

export class WsLink {
  connected = false;
  terminal = false;
  disabled = false;
  private ws: WsLike | null = null;
  private stopped = false;
  private attempt = 0;
  private everReady = false;
  private nextDelay: number | undefined;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pinger: ReturnType<typeof setInterval> | null = null;

  constructor(private o: LinkOptions) {}

  start() {
    this.open();
  }

  send(msg: unknown): boolean {
    if (!this.connected || !this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  /** iPhone: close without a code, reconnect after delayMs. */
  drop(delayMs: number) {
    if (!this.ws) return;
    this.nextDelay = delayMs;
    this.down();
    this.ws.close();
  }

  /** Redeploy: close now, reconnect on the normal backoff from attempt 0. */
  kill() {
    if (!this.ws) return;
    this.attempt = 0;
    this.down();
    this.ws.close();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.down();
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
  }

  private down() {
    if (this.pinger) clearInterval(this.pinger);
    this.pinger = null;
    if (this.connected) {
      this.connected = false;
      this.o.onState?.(false);
    }
  }

  private open() {
    if (this.stopped) return;
    let ws: WsLike;
    try {
      ws = new this.o.impl(this.o.url);
    } catch {
      this.schedule();
      return;
    }
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify(this.o.auth));
    ws.onmessage = (ev) => {
      if (this.ws !== ws || typeof ev.data !== "string" || ev.data === WS_PONG) return;
      let m: ServerLike;
      try {
        m = JSON.parse(ev.data) as ServerLike;
      } catch {
        return;
      }
      if (m.t === "ready" && !this.connected) {
        this.connected = true;
        this.attempt = 0;
        if (this.everReady) this.o.onReconnect?.();
        this.everReady = true;
        this.pinger = setInterval(() => {
          try {
            ws.send(WS_PING);
          } catch {}
        }, PING_EVERY_MS);
        this.o.onState?.(true);
      }
      this.o.onMessage(m);
    };
    ws.onerror = () => {};
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.down();
      const code = ev?.code ?? 1006;
      this.o.onClose?.(code);
      if (this.stopped) return;
      if (TERMINAL_CODES.has(code)) {
        this.terminal = true;
        this.stopped = true;
        this.o.onTerminal?.(code);
        return;
      }
      if (code === DISABLED_CODE) {
        this.disabled = true;
        this.stopped = true;
        this.o.onDisabled?.();
        return;
      }
      this.schedule();
    };
  }

  private schedule() {
    if (this.stopped) return;
    const d = this.nextDelay ?? reconnectDelayMs(this.attempt++, this.o.rand);
    this.nextDelay = undefined;
    this.timer = setTimeout(() => this.open(), d);
  }
}
