import { describe, expect, it } from "vitest";

import {
  CHUNK,
  FLUSH_EVERY_MS,
  HTTP_WAIT_MS,
  MIN_PLAYER_GAP_MS,
  RETRY_MS,
  RoomCore,
  type Attachment,
  type BatchResult,
  type RoomDb,
  type TickEntry,
} from "@/lib/live/core";
import { AUTH_TIMEOUT_MS, CLOSE, MAX_FRAME, type ServerMsg } from "@/lib/live/protocol";
import { sha256Hex } from "@/lib/server/tokens";

const SESSION = "00000000-0000-4000-8000-000000000001";
const tok = (n: number) => `token-${String(n).padStart(4, "0")}-abcdefghijklmnop`;
const pid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Sock = { id: number; sent: ServerMsg[]; closed?: { code: number; reason: string }; att?: Attachment };

class Clock {
  t = 1_700_000_000_000;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  setTimer = (ms: number, fn: () => void) => {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn });
    return id;
  };
  clearTimer = (h: unknown) => void this.timers.delete(h as number);
  /** Run every timer due within ms, letting async work settle between them. */
  async advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      await settle();
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const e of this.timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = next[1].at;
      next[1].fn();
    }
    this.t = end;
    await settle();
  }
}

async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

type BatchFn = (entries: TickEntry[]) => Promise<BatchResult>;

const okView = (e: TickEntry) => ({
  player: e.player,
  r: { ok: true, status: "live", alert_host: false, hint_all: false, session_id: SESSION, stats: { points: 1 }, lat_seen: e.lat },
});
const okBatch: BatchFn = async (entries) => ({
  ok: true, server_now: "now", status: "live", hint_all: false, alert_host: false, results: entries.map(okView),
});

function setup(opts: { batch?: BatchFn; auth?: RoomDb["playerAuth"] } = {}) {
  const clock = new Clock();
  const calls: TickEntry[][] = [];
  let batch = opts.batch ?? okBatch;
  const db: RoomDb = {
    tickBatch: (_s, entries) => {
      calls.push(entries);
      return batch(entries);
    },
    playerAuth: opts.auth ?? (async () => ({ ok: true })),
    hostAuth: async (_s, h) => ({ ok: h === (await sha256Hex(tok(999))) }),
  };
  const core = new RoomCore<Sock>(SESSION, {
    now: () => clock.t,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    sha256Hex,
    db,
    send: (s, m) => void s.sent.push(m),
    close: (s, code, reason) => void (s.closed = { code, reason }),
    attach: (s, a) => void (s.att = a),
  });
  let n = 0;
  const sock = (): Sock => {
    const s: Sock = { id: ++n, sent: [] };
    core.open(s);
    return s;
  };
  const player = async (i: number) => {
    const s = sock();
    await core.message(s, JSON.stringify({ t: "auth", role: "player", playerId: pid(i), token: tok(i) }));
    return s;
  };
  const fix = (s: Sock, lat = 59.91, extra: Record<string, unknown> = {}) =>
    core.message(s, JSON.stringify({ t: "fix", lat, lng: 10.75, acc: 5, ...extra }));
  return { clock, core, calls, sock, player, fix, setBatch: (b: BatchFn) => (batch = b) };
}

const views = (s: Sock) => s.sent.filter((m) => m.t === "view");

describe("RoomCore auth", () => {
  it("closes a socket that does not authenticate in time", async () => {
    const { clock, sock } = setup();
    const s = sock();
    await clock.advance(AUTH_TIMEOUT_MS + 1);
    expect(s.closed?.code).toBe(CLOSE.auth);
  });

  it("authenticates a player and attaches only role, id and token hash", async () => {
    const { clock, player } = setup();
    const s = await player(1);
    expect(s.sent[0]).toMatchObject({ t: "ready", role: "player" });
    expect(s.att).toEqual({ role: "player", playerId: pid(1), tokenHash: await sha256Hex(tok(1)) });
    await clock.advance(AUTH_TIMEOUT_MS + 1);
    expect(s.closed).toBeUndefined();
  });

  it("closes on a rejected player or host token", async () => {
    const { core, sock } = setup({ auth: async () => ({ ok: false, error: "auth" }) });
    const s = sock();
    await core.message(s, JSON.stringify({ t: "auth", role: "player", playerId: pid(1), token: tok(1) }));
    expect(s.closed?.code).toBe(CLOSE.auth);
    const h = sock();
    await core.message(h, JSON.stringify({ t: "auth", role: "host", hostToken: tok(1) }));
    expect(h.closed?.code).toBe(CLOSE.auth);
    const ok = sock();
    await core.message(ok, JSON.stringify({ t: "auth", role: "host", hostToken: tok(999) }));
    expect(ok.sent[0]).toMatchObject({ t: "ready", role: "host" });
  });

  it("kicked players are closed with 4403", async () => {
    const { core, sock } = setup({ auth: async () => ({ ok: false, error: "kicked" }) });
    const s = sock();
    await core.message(s, JSON.stringify({ t: "auth", role: "player", playerId: pid(1), token: tok(1) }));
    expect(s.closed?.code).toBe(CLOSE.kicked);
  });

  it("rejects fixes before auth, bad frames and oversized frames", async () => {
    const { core, sock, fix } = setup();
    const a = sock();
    await fix(a);
    expect(a.closed?.code).toBe(CLOSE.auth);
    const b = sock();
    await core.message(b, "{nope");
    expect(b.closed?.code).toBe(CLOSE.bad_message);
    const c = sock();
    await core.message(c, "x".repeat(MAX_FRAME + 1));
    expect(c.closed?.code).toBe(CLOSE.bad_message);
  });

  it("a socket restored after hibernation can send fixes", async () => {
    const { core, clock, calls } = setup();
    const s: Sock = { id: 50, sent: [] };
    core.restore(s, { role: "player", playerId: pid(5), tokenHash: "h".repeat(64) });
    await core.message(s, JSON.stringify({ t: "fix", lat: 59.9, lng: 10.7, acc: 5 }));
    await clock.advance(60);
    expect(calls[0][0]).toMatchObject({ player: pid(5), token_hash: "h".repeat(64) });
    expect(views(s)).toHaveLength(1);
  });
});

describe("RoomCore batching", () => {
  it("flushes once per second with every waiting player in one call", async () => {
    const { clock, player, fix, calls } = setup();
    const a = await player(1);
    const b = await player(2);
    await fix(a);
    await fix(b);
    await clock.advance(60);
    expect(calls).toHaveLength(1);
    expect(calls[0].map((e) => e.player).sort()).toEqual([pid(1), pid(2)]);
    expect(views(a)).toHaveLength(1);
    expect(views(b)).toHaveLength(1);
  });

  it("fixes arriving close together share one call", async () => {
    const { clock, player, fix, calls } = setup();
    const a = await player(1);
    const b = await player(2);
    await fix(a);
    await clock.advance(20);
    await fix(b);
    await clock.advance(60);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(2);
  });

  it("strips internal flags from the pushed view", async () => {
    const { clock, player, fix } = setup();
    const a = await player(1);
    await fix(a);
    await clock.advance(60);
    const v = (views(a)[0] as { v: Record<string, unknown> }).v;
    expect(v).not.toHaveProperty("ok");
    expect(v).not.toHaveProperty("alert_host");
    expect(v).not.toHaveProperty("hint_all");
    expect(v).not.toHaveProperty("session_id");
    expect(v).toMatchObject({ status: "live" });
  });

  it("coalesces fixes: newest position wins, steps add up", async () => {
    const { clock, player, fix, calls } = setup();
    const a = await player(1);
    await fix(a, 59.1, { steps: 4, ts: 1000 });
    await fix(a, 59.2, { steps: 6, ts: 2000 });
    await clock.advance(60);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({ lat: 59.2, steps: 10, client_ts: new Date(2000).toISOString() });
  });

  it("keeps each player's ticks at least 1.9 s apart (speed stays honest)", async () => {
    const { clock, player, fix, calls } = setup();
    const a = await player(1);
    await fix(a);
    await clock.advance(60);
    expect(calls).toHaveLength(1);
    await clock.advance(FLUSH_EVERY_MS); // t ≈ 1.01 s
    await fix(a);
    await clock.advance(MIN_PLAYER_GAP_MS - FLUSH_EVERY_MS - 100);
    expect(calls).toHaveLength(1);
    await clock.advance(200);
    expect(calls).toHaveLength(2);
  });

  it("never runs two flushes at once and never stacks them", async () => {
    let release: () => void = () => {};
    const { clock, player, fix, calls, setBatch } = setup();
    setBatch((entries) => new Promise((r) => (release = () => void okBatch(entries).then(r))));
    const a = await player(1);
    const b = await player(2);
    await fix(a);
    await clock.advance(60);
    expect(calls).toHaveLength(1);
    await fix(b);
    await clock.advance(5000); // DB is slow: b waits
    expect(calls).toHaveLength(1);
    setBatch(okBatch);
    release();
    await clock.advance(60);
    expect(calls).toHaveLength(2);
    expect(calls[1].map((e) => e.player)).toEqual([pid(2)]);
  });

  it("splits big sessions into chunks below the SQL cap", async () => {
    const { clock, player, fix, calls } = setup();
    for (let i = 1; i <= 90; i++) await fix(await player(i));
    await clock.advance(60);
    expect(calls.map((c) => c.length)).toEqual([CHUNK, CHUNK, 90 - 2 * CHUNK]);
  });

  it("retries busy players on the next flush, newest fix first", async () => {
    let first = true;
    const { clock, player, fix, calls, setBatch } = setup();
    setBatch(async (entries) => {
      if (!first) return okBatch(entries);
      first = false;
      return { ok: true, server_now: "n", status: "live", hint_all: false, alert_host: false,
               results: entries.map((e) => ({ player: e.player, r: { ok: false, error: "busy" } })) };
    });
    const a = await player(1);
    await fix(a, 59.1);
    await clock.advance(60);
    expect(views(a)).toHaveLength(0);
    await fix(a, 59.3);
    await clock.advance(FLUSH_EVERY_MS);
    expect(calls).toHaveLength(2);
    expect(calls[1][0].lat).toBe(59.3);
    expect(views(a)).toHaveLength(1);
  });

  it("retries a failed RPC once, then keeps the fix for the next flush", async () => {
    let fails = 3;
    const { clock, player, fix, calls, setBatch } = setup();
    setBatch(async (entries) => {
      if (fails-- > 0) throw new Error("down");
      return okBatch(entries);
    });
    const a = await player(1);
    await fix(a);
    await clock.advance(RETRY_MS + 60);
    expect(calls).toHaveLength(2); // first try + one retry
    expect(views(a)).toHaveLength(0);
    await clock.advance(FLUSH_EVERY_MS * 3);
    expect(views(a)).toHaveLength(1);
  });

  it("stale is silent, other errors are reported, kicked players are closed", async () => {
    const { clock, player, fix, setBatch } = setup();
    const errs: Record<string, string> = { [pid(1)]: "stale", [pid(2)]: "bad_fix", [pid(3)]: "kicked" };
    setBatch(async (entries) => ({ ok: true, server_now: "n", status: "live", hint_all: false, alert_host: false,
      results: entries.map((e) => ({ player: e.player, r: { ok: false, error: errs[e.player] } })) }));
    const [a, b, c] = [await player(1), await player(2), await player(3)];
    for (const s of [a, b, c]) await fix(s);
    await clock.advance(60);
    expect(a.sent.filter((m) => m.t === "err")).toHaveLength(0);
    expect(b.sent).toContainEqual({ t: "err", error: "bad_fix" });
    expect(c.closed?.code).toBe(CLOSE.kicked);
  });

  it("hint_all goes to players, alert_host only to teacher screens", async () => {
    const { clock, core, sock, player, fix, setBatch } = setup();
    setBatch(async (entries) => ({ ...(await okBatch(entries)), hint_all: true, alert_host: true } as BatchResult));
    const a = await player(1);
    const h = sock();
    await core.message(h, JSON.stringify({ t: "auth", role: "host", hostToken: tok(999) }));
    await fix(a);
    await clock.advance(60);
    expect(a.sent).toContainEqual({ t: "hint" });
    expect(a.sent).not.toContainEqual({ t: "alarm" });
    expect(h.sent).toContainEqual({ t: "alarm" });
    expect(h.sent).not.toContainEqual({ t: "hint" });
  });

  it("an ended session closes everyone and refuses more work", async () => {
    const { clock, core, player, fix, setBatch } = setup();
    setBatch(async () => ({ ok: false, error: "ended" }));
    const a = await player(1);
    const b = await player(2);
    await fix(a);
    await clock.advance(60);
    expect(a.closed?.code).toBe(CLOSE.ended);
    expect(b.closed?.code).toBe(CLOSE.ended);
    expect(core.isEnded).toBe(true);
    await expect(core.httpTick(pid(3), "h".repeat(64), { lat: 1, lng: 1, acc: 1, speed: null })).resolves.toMatchObject({ status: 410 });
  });

  it("closes sockets that flood the room", async () => {
    const { core, player } = setup();
    const a = await player(1);
    for (let i = 0; i < 40 && !a.closed; i++) await core.message(a, JSON.stringify({ t: "fix", lat: 59, lng: 10, acc: 5 }));
    expect(a.closed?.code).toBe(CLOSE.rate);
  });
});

describe("RoomCore HTTP fallback", () => {
  it("answers with the player's own view through the same batch", async () => {
    const { clock, core, player, fix, calls } = setup();
    const a = await player(1);
    await fix(a);
    const p = core.httpTick(pid(2), "h".repeat(64), { lat: 59.5, lng: 10, acc: 5, speed: null });
    await clock.advance(60);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(2);
    await expect(p).resolves.toMatchObject({ status: 200, body: { status: "live", lat_seen: 59.5 } });
  });

  it("gives up with 503 when the database does not answer", async () => {
    const { clock, core, setBatch } = setup();
    setBatch(() => new Promise(() => {}));
    const p = core.httpTick(pid(2), "h".repeat(64), { lat: 59.5, lng: 10, acc: 5, speed: null });
    await clock.advance(HTTP_WAIT_MS + 10);
    await expect(p).resolves.toMatchObject({ status: 503 });
  });

  it("maps errors to the tick route's statuses", async () => {
    const { clock, core, setBatch } = setup();
    setBatch(async (entries) => ({ ok: true, server_now: "n", status: "live", hint_all: false, alert_host: false,
      results: entries.map((e) => ({ player: e.player, r: { ok: false, error: "stale" } })) }));
    const p = core.httpTick(pid(2), "h".repeat(64), { lat: 59.5, lng: 10, acc: 5, speed: null });
    await clock.advance(60);
    await expect(p).resolves.toEqual({ status: 409, body: { error: "stale" } });
  });
});
