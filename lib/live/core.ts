import {
  AUTH_TIMEOUT_MS,
  CLOSE,
  MAX_FRAME,
  parseClientMsg,
  stripView,
  type FixMsg,
  type ServerMsg,
} from "./protocol";

// RoomCore: the session room's logic with every side effect injected (clock,
// timers, database, sockets), so it runs unchanged in the Durable Object and in
// vitest. Durable Objects stage 1, ADR-031.
//
// The room collects each player's latest fix and flushes them to Postgres in
// one chase.tick_batch call about once a second. Postgres stays the authority:
// every entry runs the existing chase.tick() and the personal view goes back to
// the player's socket (or the waiting HTTP request).
//
// Privacy (CLAUDE.md rule 3): fixes live in memory only, are dropped once
// written, and are never logged or persisted. Socket attachments hold role,
// player id and token HASH only.

export const FLUSH_EVERY_MS = 1000;
/**
 * Minimum time between two ticks of the same player. _tick_base measures a
 * segment as now() − previous fix_at, and now() is the flush time; keeping each
 * player's gap ≥ 1.9 s (clients sample every 2 s) means speed is never
 * over-read by more than ~5 % — the 8 m/s anti-teleport rule and the active-time
 * band of ADR-014 stay valid.
 */
export const MIN_PLAYER_GAP_MS = 1900;
/** chase.tick_batch accepts 50; stay below so nested subtransactions (alarms) keep headroom. */
export const CHUNK = 40;
/** A fix waits at least this long so fixes arriving together share one call. */
export const COALESCE_MS = 50;
export const RETRY_MS = 300;
export const HTTP_WAIT_MS = 8000;
/** Token bucket per socket: refill per second and burst. Clients send one fix per 2 s. */
export const RATE_PER_S = 2;
export const RATE_BURST = 6;
/** Dropped frames in one second before the socket is closed. */
export const RATE_CLOSE_AT = 18;
export const MAX_STEPS = 500;

export type Role = "player" | "host";

/** What survives hibernation on the socket itself. No positions, no raw tokens. */
export type Attachment = { role: Role; playerId?: string; tokenHash?: string };

export type TickEntry = {
  player: string;
  token_hash: string;
  lat: number;
  lng: number;
  acc: number;
  speed: number | null;
  client_ts: string | null;
  steps: number | null;
};

export type EntryResult = { player: string; r: { ok: boolean; error?: string } & Record<string, unknown> };
export type BatchResult =
  | { ok: true; server_now: string; status: string; hint_all: boolean; alert_host: boolean; results: EntryResult[] }
  | { ok: false; error: string };

export type AuthResult = { ok: boolean; error?: string };

export interface RoomDb {
  tickBatch(session: string, entries: TickEntry[]): Promise<BatchResult>;
  playerAuth(session: string, playerId: string, tokenHash: string): Promise<AuthResult>;
  hostAuth(session: string, hostTokenHash: string): Promise<AuthResult>;
}

export interface RoomDeps<S> {
  now(): number;
  setTimer(ms: number, fn: () => void): unknown;
  clearTimer(h: unknown): void;
  sha256Hex(s: string): Promise<string>;
  db: RoomDb;
  send(sock: S, msg: ServerMsg): void;
  close(sock: S, code: number, reason: string): void;
  /** Persist the socket's identity so it survives hibernation. */
  attach(sock: S, a: Attachment): void;
}

/** HTTP fallback answer: status + body, like the Next route would send. */
export type HttpReply = { status: number; body: Record<string, unknown> };

type Conn = {
  authed: boolean;
  role?: Role;
  playerId?: string;
  tokenHash?: string;
  authTimer?: unknown;
  tokens: number;
  refillAt: number;
  dropSec: number;
  drops: number;
};

type Pending = {
  entry: TickEntry;
  tokenHash: string;
  receivedAt: number;
  waiters: Array<(r: HttpReply) => void>;
};

/** Error codes → HTTP status, as lib/server/rpc.ts maps them for the tick route. */
const HTTP_STATUS: Record<string, number> = {
  auth: 401, not_found: 404, kicked: 403, left: 403, stale: 409, busy: 409, ended: 410, bad_fix: 400,
};
/** Errors that end the player's connection. */
const FATAL: Record<string, number> = {
  auth: CLOSE.auth, not_found: CLOSE.not_found, kicked: CLOSE.kicked, left: CLOSE.kicked, ended: CLOSE.ended,
};

export type RoomStats = {
  sockets: number; players: number; hosts: number; pending: number;
  flushes: number; entries: number; busy: number; rpcErrors: number; drops: number; connects: number;
  flushP50: number; flushP95: number; batchP50: number; batchMax: number;
};

function pct(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

export class RoomCore<S> {
  private conns = new Map<S, Conn>();
  private pending = new Map<string, Pending>();
  private lastTickAt = new Map<string, number>();
  private flushing = false;
  private lastFlushStart = -Infinity;
  private timer: unknown = null;
  private timerAt = Infinity;
  private ended = false;
  private st = { flushes: 0, entries: 0, busy: 0, rpcErrors: 0, drops: 0, connects: 0 };
  private flushMs: number[] = [];
  private batchSizes: number[] = [];

  constructor(readonly session: string, private d: RoomDeps<S>) {}

  // ───────────────────────── sockets ─────────────────────────

  /** A new socket: it must authenticate within AUTH_TIMEOUT_MS. */
  open(sock: S): void {
    const now = this.d.now();
    const c: Conn = { authed: false, tokens: RATE_BURST, refillAt: now, dropSec: Math.floor(now / 1000), drops: 0 };
    c.authTimer = this.d.setTimer(AUTH_TIMEOUT_MS, () => {
      if (!c.authed && this.conns.get(sock) === c) this.drop(sock, CLOSE.auth, "auth timeout");
    });
    this.conns.set(sock, c);
    this.st.connects++;
  }

  /** After hibernation: the runtime still has the socket, memory does not. */
  restore(sock: S, a: Attachment | null): void {
    if (!a?.role) return;
    const now = this.d.now();
    this.conns.set(sock, {
      authed: true, role: a.role, playerId: a.playerId, tokenHash: a.tokenHash,
      tokens: RATE_BURST, refillAt: now, dropSec: Math.floor(now / 1000), drops: 0,
    });
  }

  closed(sock: S): void {
    const c = this.conns.get(sock);
    if (c?.authTimer) this.d.clearTimer(c.authTimer);
    this.conns.delete(sock);
  }

  async message(sock: S, raw: string): Promise<void> {
    const c = this.conns.get(sock);
    if (!c) return;
    if (raw.length > MAX_FRAME) return this.drop(sock, CLOSE.bad_message, "frame too large");
    if (!this.allow(c)) {
      this.st.drops++;
      if (c.drops >= RATE_CLOSE_AT) this.drop(sock, CLOSE.rate, "rate");
      return;
    }
    const m = parseClientMsg(raw);
    if (!m) return this.drop(sock, CLOSE.bad_message, "bad message");
    if (this.ended) return this.drop(sock, CLOSE.ended, "ended");

    if (m.t === "auth") {
      if (c.authed) return;
      if (m.role === "player") {
        const hash = await this.d.sha256Hex(m.token);
        const r = await this.d.db.playerAuth(this.session, m.playerId, hash);
        if (this.conns.get(sock) !== c) return; // closed meanwhile
        if (!r.ok) return this.drop(sock, FATAL[r.error ?? "auth"] ?? CLOSE.auth, r.error ?? "auth");
        this.authed(sock, c, { role: "player", playerId: m.playerId, tokenHash: hash });
      } else {
        const hash = await this.d.sha256Hex(m.hostToken);
        const r = await this.d.db.hostAuth(this.session, hash);
        if (this.conns.get(sock) !== c) return;
        if (!r.ok) return this.drop(sock, FATAL[r.error ?? "auth"] ?? CLOSE.auth, r.error ?? "auth");
        this.authed(sock, c, { role: "host" });
      }
      return;
    }

    // A fix.
    if (!c.authed || c.role !== "player" || !c.playerId || !c.tokenHash) {
      return this.drop(sock, CLOSE.auth, "not authenticated");
    }
    this.queue(c.playerId, c.tokenHash, m);
  }

  private authed(sock: S, c: Conn, a: Attachment): void {
    if (c.authTimer) this.d.clearTimer(c.authTimer);
    c.authTimer = undefined;
    c.authed = true;
    c.role = a.role;
    c.playerId = a.playerId;
    c.tokenHash = a.tokenHash;
    this.d.attach(sock, a);
    this.d.send(sock, { t: "ready", role: a.role, server_now: new Date(this.d.now()).toISOString() });
  }

  private allow(c: Conn): boolean {
    const now = this.d.now();
    c.tokens = Math.min(RATE_BURST, c.tokens + ((now - c.refillAt) / 1000) * RATE_PER_S);
    c.refillAt = now;
    const sec = Math.floor(now / 1000);
    if (sec !== c.dropSec) {
      c.dropSec = sec;
      c.drops = 0;
    }
    if (c.tokens >= 1) {
      c.tokens -= 1;
      return true;
    }
    c.drops++;
    return false;
  }

  private drop(sock: S, code: number, reason: string): void {
    this.closed(sock);
    this.d.close(sock, code, reason);
  }

  // ───────────────────────── HTTP fallback ─────────────────────────

  /** iOS kills sockets when the screen locks: phones fall back to HTTP, same pipeline. */
  httpTick(playerId: string, tokenHash: string, fix: Omit<FixMsg, "t">): Promise<HttpReply> {
    if (this.ended) return Promise.resolve({ status: 410, body: { error: "ended" } });
    return new Promise((resolve) => {
      let done = false;
      const once = (r: HttpReply) => {
        if (done) return;
        done = true;
        this.d.clearTimer(t);
        resolve(r);
      };
      const t = this.d.setTimer(HTTP_WAIT_MS, () => once({ status: 503, body: { error: "timeout" } }));
      this.queue(playerId, tokenHash, { t: "fix", ...fix }, once);
    });
  }

  // ───────────────────────── batching ─────────────────────────

  private queue(playerId: string, tokenHash: string, m: FixMsg, waiter?: (r: HttpReply) => void): void {
    const prev = this.pending.get(playerId);
    // Coalesce: the newest fix wins, steps add up (they are counts since the last tick).
    const steps = Math.min(MAX_STEPS, (prev?.entry.steps ?? 0) + (m.steps ?? 0)) || null;
    const entry: TickEntry = {
      player: playerId,
      token_hash: tokenHash,
      lat: m.lat,
      lng: m.lng,
      acc: m.acc,
      speed: m.speed ?? null,
      client_ts: m.ts ? new Date(m.ts).toISOString() : null,
      steps,
    };
    const waiters = prev?.waiters ?? [];
    if (waiter) waiters.push(waiter);
    this.pending.set(playerId, { entry, tokenHash, receivedAt: prev?.receivedAt ?? this.d.now(), waiters });
    this.schedule();
  }

  private eligibleAt(playerId: string): number {
    return (this.lastTickAt.get(playerId) ?? -Infinity) + MIN_PLAYER_GAP_MS;
  }

  /** One timer for the next flush: never before the 1 s cadence, never while a flush runs. */
  private schedule(): void {
    if (this.flushing || this.ended || this.pending.size === 0) return;
    let earliest = Infinity;
    for (const id of this.pending.keys()) earliest = Math.min(earliest, this.eligibleAt(id));
    const now = this.d.now();
    const at = Math.max(earliest, this.lastFlushStart + FLUSH_EVERY_MS, now + COALESCE_MS);
    if (this.timer !== null && this.timerAt <= at) return;
    if (this.timer !== null) this.d.clearTimer(this.timer);
    this.timerAt = at;
    this.timer = this.d.setTimer(at - now, () => {
      this.timer = null;
      this.timerAt = Infinity;
      void this.flush();
    });
  }

  /** Exposed for tests and the adapter; normally driven by the timer. */
  async flush(): Promise<void> {
    if (this.flushing || this.ended) return;
    const start = this.d.now();
    const due = [...this.pending.entries()]
      .filter(([id]) => this.eligibleAt(id) <= start)
      .sort((a, b) => a[1].receivedAt - b[1].receivedAt);
    if (!due.length) return this.schedule();

    this.flushing = true;
    this.lastFlushStart = start;
    for (const [id] of due) this.pending.delete(id);
    try {
      for (let i = 0; i < due.length && !this.ended; i += CHUNK) {
        await this.runChunk(due.slice(i, i + CHUNK).map(([, p]) => p), start);
      }
    } finally {
      this.flushing = false;
      this.st.flushes++;
      this.flushMs.push(this.d.now() - start);
      if (this.flushMs.length > 200) this.flushMs.shift();
      this.schedule();
    }
  }

  private async runChunk(chunk: Pending[], start: number): Promise<void> {
    const entries = chunk.map((p) => p.entry);
    this.batchSizes.push(entries.length);
    if (this.batchSizes.length > 200) this.batchSizes.shift();
    this.st.entries += entries.length;

    let res: BatchResult | null = null;
    for (let attempt = 0; attempt < 2 && !res; attempt++) {
      try {
        res = await this.d.db.tickBatch(this.session, entries);
      } catch {
        this.st.rpcErrors++;
        if (attempt === 0) await new Promise<void>((r) => this.d.setTimer(RETRY_MS, r));
      }
    }
    if (!res) {
      for (const p of chunk) this.requeue(p); // try again on the next flush
      return;
    }
    if (!res.ok) {
      if (res.error === "ended") return this.end();
      if (res.error === "not_found") return this.closeAll(CLOSE.not_found, "not_found");
      this.st.rpcErrors++;
      for (const p of chunk) this.requeue(p);
      return;
    }

    const byPlayer = new Map(chunk.map((p) => [p.entry.player, p]));
    for (const { player, r } of res.results) {
      const p = byPlayer.get(player);
      if (!p) continue;
      if (r.ok) {
        this.lastTickAt.set(player, start);
        const v = stripView(r);
        this.toPlayer(player, { t: "view", v });
        this.reply(p, { status: 200, body: v });
        continue;
      }
      const err = r.error ?? "server";
      if (err === "busy") {
        this.st.busy++;
        this.requeue(p);
      } else if (err === "ended") {
        this.reply(p, { status: 410, body: { error: err } });
        return this.end();
      } else if (FATAL[err]) {
        this.reply(p, { status: HTTP_STATUS[err] ?? 403, body: { error: err } });
        this.closePlayer(player, FATAL[err], err);
      } else {
        // stale, bad_fix, server: this fix is done, the next one will do.
        if (err !== "stale") this.toPlayer(player, { t: "err", error: err });
        this.reply(p, { status: HTTP_STATUS[err] ?? 500, body: { error: err } });
      }
    }

    if (res.hint_all) this.toPlayers({ t: "hint" });
    if (res.alert_host) this.toHosts({ t: "alarm" });
  }

  /** Put a fix back unless a newer one arrived meanwhile; waiters move along. */
  private requeue(p: Pending): void {
    const newer = this.pending.get(p.entry.player);
    if (newer) {
      newer.waiters.push(...p.waiters);
      newer.receivedAt = Math.min(newer.receivedAt, p.receivedAt);
      newer.entry.steps = Math.min(MAX_STEPS, (newer.entry.steps ?? 0) + (p.entry.steps ?? 0)) || null;
    } else {
      this.pending.set(p.entry.player, p);
    }
  }

  private reply(p: Pending, r: HttpReply): void {
    for (const w of p.waiters) w(r);
    p.waiters = [];
  }

  // ───────────────────────── fan-out ─────────────────────────

  private toPlayer(playerId: string, msg: ServerMsg): void {
    for (const [s, c] of this.conns) if (c.authed && c.playerId === playerId) this.d.send(s, msg);
  }

  private toPlayers(msg: ServerMsg): void {
    for (const [s, c] of this.conns) if (c.authed && c.role === "player") this.d.send(s, msg);
  }

  private toHosts(msg: ServerMsg): void {
    for (const [s, c] of this.conns) if (c.authed && c.role === "host") this.d.send(s, msg);
  }

  private closePlayer(playerId: string, code: number, reason: string): void {
    for (const [s, c] of [...this.conns]) if (c.playerId === playerId) this.drop(s, code, reason);
    this.pending.delete(playerId);
  }

  closeAll(code: number, reason: string): void {
    for (const s of [...this.conns.keys()]) this.drop(s, code, reason);
    for (const p of this.pending.values()) this.reply(p, { status: code === CLOSE.ended ? 410 : 503, body: { error: reason } });
    this.pending.clear();
  }

  /** Session over: everyone out, memory wiped. The room refuses further work. */
  end(): void {
    this.ended = true;
    if (this.timer !== null) this.d.clearTimer(this.timer);
    this.timer = null;
    this.closeAll(CLOSE.ended, "ended");
    this.lastTickAt.clear();
  }

  get isEnded(): boolean {
    return this.ended;
  }

  stats(): RoomStats {
    let players = 0;
    let hosts = 0;
    for (const c of this.conns.values()) {
      if (c.role === "player") players++;
      else if (c.role === "host") hosts++;
    }
    return {
      sockets: this.conns.size, players, hosts, pending: this.pending.size, ...this.st,
      flushP50: pct(this.flushMs, 50), flushP95: pct(this.flushMs, 95),
      batchP50: pct(this.batchSizes, 50), batchMax: this.batchSizes.length ? Math.max(...this.batchSizes) : 0,
    };
  }
}
