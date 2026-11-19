import { describe, expect, it } from "vitest";

import {
  CHUNK,
  FLUSH_EVERY_MS,
  HTTP_WAIT_MS,
  MIN_PLAYER_GAP_MS,
  HOST_DEBOUNCE_MS,
  HOST_EVERY_MS,
  RETRY_MS,
  RoomCore,
  URGENT_EVERY_MS,
  WATCHDOG_EVERY_MS,
  type WatchdogState,
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

type Snap = Record<string, unknown>;
type SnapFn = () => Promise<Snap>;

function setup(opts: { batch?: BatchFn; auth?: RoomDb["playerAuth"] } = {}) {
  const clock = new Clock();
  const calls: TickEntry[][] = [];
  let batch = opts.batch ?? okBatch;
  let snap: SnapFn = async () => ({ ok: true, status: "live", players: [] });
  let snapCalls = 0;
  const wd = {
    alarm: null as number | null, alarmSets: 0, saved: null as WatchdogState | null, wiped: false,
    setAlarm: (at: number) => void ((wd.alarm = at), wd.alarmSets++),
    deleteAlarm: () => void (wd.alarm = null),
    save: (s: WatchdogState) => void (wd.saved = s),
    wipe: () => void ((wd.wiped = true), (wd.alarm = null)),
  };
  const db: RoomDb = {
    tickBatch: (_s, entries) => {
      calls.push(entries);
      return batch(entries);
    },
    playerAuth: opts.auth ?? (async () => ({ ok: true })),
    hostAuth: async (_s, h) => ({ ok: h === (await sha256Hex(tok(999))) }),
    hostSnapshot: () => {
      snapCalls++;
      return snap();
    },
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
    watchdog: wd,
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
  const host = async () => {
    const s = sock();
    await core.message(s, JSON.stringify({ t: "auth", role: "host", hostToken: tok(999) }));
    return s;
  };
  return {
    clock, core, calls, sock, player, fix, host, wd,
    setBatch: (b: BatchFn) => (batch = b),
    setSnap: (f: SnapFn) => (snap = f),
    snapCalls: () => snapCalls,
  };
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

describe("RoomCore urgent fixes (rule 4, ADR-038)", () => {
  it("writes an urgent fix at once, inside the player's 1.9 s gap and the 1 s cadence", async () => {
    const { clock, player, fix, calls, core } = setup();
    const a = await player(1);
    const b = await player(2);
    await fix(a);
    await fix(b);
    await clock.advance(60);
    expect(calls).toHaveLength(1);
    await clock.advance(300); // 0.36 s after a's last tick: normally it waits until 1.9 s
    await fix(a, 59.2, { urgent: true });
    await clock.advance(0);
    expect(calls).toHaveLength(2);
    expect(calls[1].map((e) => e.player)).toEqual([pid(1)]);
    expect(calls[1][0].lat).toBe(59.2);
    expect(views(a)).toHaveLength(2);
    expect(core.stats().urgent).toBe(1);
  });

  it("does not move the 1 s cadence for the others", async () => {
    const { clock, player, fix, calls } = setup();
    const a = await player(1);
    const b = await player(2);
    await fix(b);
    await clock.advance(60); // b ticks at t0
    await clock.advance(FLUSH_EVERY_MS);
    await fix(a, 59.2, { urgent: true }); // urgent flush at ~1.06 s
    await clock.advance(0);
    expect(calls).toHaveLength(2);
    await fix(b); // eligible at 1.9 s after its tick, the cadence allows it from 1.06 s
    // b ticked at 50 ms, so it may go at 1.95 s; had the urgent flush at 1.06 s moved
    // the cadence, b would wait until 2.06 s.
    await clock.advance(MIN_PLAYER_GAP_MS - FLUSH_EVERY_MS);
    expect(calls).toHaveLength(3);
    expect(calls[2].map((e) => e.player)).toEqual([pid(2)]);
  });

  it("lets one urgent fix per player through every URGENT_EVERY_MS; the rest get the normal pace", async () => {
    const { clock, player, fix, calls, core } = setup();
    const a = await player(1);
    await fix(a, 59.1, { urgent: true });
    await clock.advance(0);
    expect(calls).toHaveLength(1);
    await clock.advance(500);
    await fix(a, 59.2, { urgent: true }); // flagged again 0.5 s later: guard says normal pace
    await clock.advance(0);
    expect(calls).toHaveLength(1);
    await clock.advance(MIN_PLAYER_GAP_MS - 500);
    expect(calls).toHaveLength(2);
    expect(core.stats().urgent).toBe(1);
    await clock.advance(URGENT_EVERY_MS);
    await fix(a, 59.3, { urgent: true });
    await clock.advance(0);
    expect(calls).toHaveLength(3);
    expect(core.stats().urgent).toBe(2);
  });

  it("a newer plain fix keeps the pending fix urgent (newest position goes out at once)", async () => {
    let release: () => void = () => {};
    const { clock, player, fix, calls, setBatch } = setup();
    const a = await player(1);
    const b = await player(2);
    setBatch((entries) => new Promise((r) => (release = () => void okBatch(entries).then(r))));
    await fix(b);
    await clock.advance(60); // a flush is in flight
    await fix(a, 59.1, { urgent: true });
    await fix(a, 59.2);
    await clock.advance(0);
    expect(calls).toHaveLength(1); // never two flushes at once
    setBatch(okBatch);
    release();
    await clock.advance(0);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual([expect.objectContaining({ player: pid(1), lat: 59.2 })]);
  });

  it("a busy urgent fix retries at the normal pace, not in a tight loop", async () => {
    let busy = 3;
    const { clock, player, fix, calls, setBatch } = setup();
    setBatch(async (entries) =>
      busy-- > 0
        ? { ok: true, server_now: "n", status: "live", hint_all: false, alert_host: false,
            results: entries.map((e) => ({ player: e.player, r: { ok: false, error: "busy" } })) }
        : okBatch(entries));
    const a = await player(1);
    await fix(a, 59.1, { urgent: true });
    await clock.advance(10);
    expect(calls).toHaveLength(1);
    // One normal retry (the urgent flag is gone), then the 1 s cadence: no tight loop.
    await clock.advance(FLUSH_EVERY_MS - 100);
    expect(calls).toHaveLength(2);
    await clock.advance(FLUSH_EVERY_MS * 2 + 100);
    expect(calls).toHaveLength(4);
    expect(views(a)).toHaveLength(1);
  });

  it("alert_host from an urgent fix reaches the teacher screen at once", async () => {
    const { clock, player, fix, host, setBatch, snapCalls } = setup();
    const h = await host();
    await clock.advance(10);
    const before = snapCalls();
    const a = await player(1);
    await fix(a);
    await clock.advance(60);
    setBatch(async (entries) => ({ ...(await okBatch(entries)), alert_host: true } as BatchResult));
    await clock.advance(200);
    await fix(a, 59.2, { urgent: true });
    await clock.advance(0);
    expect(h.sent.some((m) => m.t === "alarm")).toBe(true);
    expect(snapCalls()).toBeGreaterThan(before);
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

  it("withdraws a still-queued fix on timeout, so the route's fallback does not tick it twice", async () => {
    const { clock, core, setBatch, calls } = setup();
    let fail = true;
    setBatch(async (entries) => {
      if (fail) throw new Error("down");
      return { ok: true, server_now: "n", status: "live", hint_all: false, alert_host: false,
        results: entries.map((e) => ({ player: e.player, r: { ok: true, status: "live" } })) };
    });
    const p = core.httpTick(pid(2), "h".repeat(64), { lat: 59.5, lng: 10, acc: 5, speed: null, steps: 10 });
    await clock.advance(HTTP_WAIT_MS + 10);
    await expect(p).resolves.toMatchObject({ status: 503 });
    fail = false;
    const n = calls.flat().length;
    await clock.advance(5000);
    expect(calls.flat()).toHaveLength(n);
    expect(core.stats().pending).toBe(0);
  });

  it("does not requeue an in-flight fix whose HTTP waiter timed out", async () => {
    const { clock, core, setBatch, calls } = setup();
    let release: (() => void) | null = null;
    setBatch(() => new Promise((_res, rej) => (release = () => rej(new Error("down")))));
    const p = core.httpTick(pid(2), "h".repeat(64), { lat: 59.5, lng: 10, acc: 5, speed: null });
    await clock.advance(HTTP_WAIT_MS + 10);
    await expect(p).resolves.toMatchObject({ status: 503 });
    setBatch(async () => {
      throw new Error("still down");
    });
    (release as (() => void) | null)?.();
    await clock.advance(400); // the retry fails too → requeue
    setBatch(async (entries) => ({ ok: true, server_now: "n", status: "live", hint_all: false, alert_host: false,
      results: entries.map((e) => ({ player: e.player, r: { ok: true, status: "live" } })) }));
    const n = calls.flat().length;
    expect(n).toBe(2);
    await clock.advance(5000);
    expect(calls.flat()).toHaveLength(n);
    expect(core.stats().pending).toBe(0);
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

const hostMsgs = (s: Sock) => s.sent.filter((m) => m.t === "host");
const hints = (s: Sock) => s.sent.filter((m) => m.t === "hint");

describe("RoomCore host push", () => {
  it("makes one DB call per tick for any number of hosts and stops without hosts", async () => {
    const { clock, host, snapCalls, core } = setup();
    const hs = [await host(), await host(), await host()];
    await clock.advance(HOST_DEBOUNCE_MS + 10);
    const base = snapCalls(); // join refreshes: coalesced, not one per host
    expect(base).toBeLessThanOrEqual(2);
    await clock.advance(HOST_EVERY_MS * 3);
    expect(snapCalls() - base).toBe(3); // 3 ticks, 3 hosts: still 3 calls
    for (const h of hs) expect(hostMsgs(h).length).toBeGreaterThanOrEqual(3);
    expect(core.stats().hostPushes).toBe(base + 3);
    for (const h of hs) core.closed(h);
    const n = snapCalls();
    await clock.advance(HOST_EVERY_MS * 5);
    expect(snapCalls()).toBe(n);
  });

  it("strips internal flags from the pushed snapshot", async () => {
    const { clock, host, setSnap } = setup();
    setSnap(async () => ({ ok: true, status: "live", alert_host: false, hint_all: false, players: [1] }));
    const h = await host();
    await clock.advance(10);
    expect(hostMsgs(h)[0]).toEqual({ t: "host", v: { status: "live", players: [1] } });
  });

  it("never has two snapshots in flight", async () => {
    const { clock, host, setSnap, snapCalls, core } = setup();
    let release: (v: Snap) => void = () => {};
    setSnap(() => new Promise<Snap>((r) => (release = r)));
    await host();
    await clock.advance(1000);
    void core.notify("alarm");
    await clock.advance(HOST_DEBOUNCE_MS * 3);
    expect(snapCalls()).toBe(1);
    release({ ok: true, status: "live" });
    await clock.advance(HOST_DEBOUNCE_MS * 3);
    expect(snapCalls()).toBe(2); // the queued refresh, once
  });

  it("alert_host in a flush triggers an immediate refresh; bursts are debounced", async () => {
    const { clock, host, player, fix, setBatch, snapCalls, setSnap } = setup();
    const h = await host();
    await clock.advance(HOST_DEBOUNCE_MS + 10);
    const before = snapCalls();
    setSnap(async () => ({ ok: true, status: "live", alarms: [1] }));
    setBatch(async (entries) => ({
      ok: true, server_now: "n", status: "live", hint_all: false, alert_host: true, results: entries.map(okView),
    }));
    const p1 = await player(1);
    const p2 = await player(2);
    await fix(p1);
    await fix(p2);
    await clock.advance(60);
    expect(h.sent.some((m) => m.t === "alarm")).toBe(true);
    expect(snapCalls() - before).toBe(1);
    expect(hostMsgs(h).at(-1)).toMatchObject({ v: { alarms: [1] } });
  });

  it("debounces event refreshes: first at once, the burst coalesces into one 200 ms later", async () => {
    const { clock, host, core, snapCalls } = setup();
    await host();
    await clock.advance(HOST_DEBOUNCE_MS + 10);
    const n = snapCalls();
    await core.notify("alarm");
    await core.notify("alarm");
    await core.notify("alarm");
    await settle();
    expect(snapCalls() - n).toBe(1);
    await clock.advance(HOST_DEBOUNCE_MS + 1);
    expect(snapCalls() - n).toBe(2);
    await clock.advance(HOST_DEBOUNCE_MS * 3);
    expect(snapCalls() - n).toBe(2);
  });

  it("closes everything when the snapshot says not_found, ends on error ended", async () => {
    const { clock, host, setSnap, core } = setup();
    const h = await host();
    setSnap(async () => ({ ok: false, error: "ended" }));
    await clock.advance(HOST_EVERY_MS + 10);
    expect(core.isEnded).toBe(true);
    expect(h.closed?.code).toBe(CLOSE.ended);
  });
});

describe("RoomCore notify", () => {
  it("alarm refreshes hosts at once", async () => {
    const { clock, host, core, snapCalls } = setup();
    await host();
    await clock.advance(500);
    const n = snapCalls();
    await core.notify("alarm");
    await settle();
    expect(snapCalls()).toBe(n + 1);
  });

  it("state hints players and refreshes hosts, but never re-ticks a remembered fix", async () => {
    const { clock, core, player, fix, host, calls, snapCalls } = setup();
    const a = await player(1);
    const b = await player(2);
    await fix(a);
    await clock.advance(100);
    await fix(b, 59.5);
    await clock.advance(1100);
    expect(calls.flat()).toHaveLength(2);
    const h = await host();
    await clock.advance(HOST_DEBOUNCE_MS + 10);
    const n = snapCalls();
    await core.notify("state");
    await settle();
    expect(hints(a)).toHaveLength(1);
    expect(hints(b)).toHaveLength(1);
    expect(hints(h)).toHaveLength(0);
    expect(snapCalls()).toBe(n + 1);
    // A re-tick of an old fix would stamp fix_at = now and clear signal alarms (rule 4).
    await clock.advance(MIN_PLAYER_GAP_MS + 5000);
    expect(calls.flat()).toHaveLength(2);
  });

  it("end pushes a final host view, closes all sockets 4410 and wipes", async () => {
    const { clock, core, player, host, wd, setSnap } = setup();
    const a = await player(1);
    const h = await host();
    await clock.advance(10);
    setSnap(async () => ({ ok: true, status: "ended", players: [] }));
    const before = hostMsgs(h).length;
    await core.notify("end");
    expect(hostMsgs(h).length).toBe(before + 1);
    expect(a.closed?.code).toBe(CLOSE.ended);
    expect(h.closed?.code).toBe(CLOSE.ended);
    expect(core.isEnded).toBe(true);
    expect(wd.wiped).toBe(true);
    expect(core.stats().hosts).toBe(0);
    const n = h.sent.length;
    await clock.advance(60_000);
    expect(h.sent.length).toBe(n);
    expect(wd.alarm).toBeNull();
  });
});

describe("RoomCore watchdog", () => {
  it("re-arms when the stored deadline is long past (lost alarm)", async () => {
    const { clock, core, player, fix, wd } = setup();
    core.restoreState({ status: "live", watchdogDue: clock.t - 60_000 });
    const a = await player(1);
    await fix(a);
    await clock.advance(100);
    expect(wd.alarm).not.toBeNull();
    expect(wd.alarm!).toBeGreaterThan(clock.t);
  });

  it("arms on the first successful flush and re-arms in active phases without sockets", async () => {
    const { clock, core, player, fix, wd, snapCalls } = setup();
    const a = await player(1);
    await fix(a);
    await clock.advance(60);
    expect(wd.alarm).not.toBeNull();
    core.closed(a);
    for (let i = 0; i < 3; i++) {
      clock.t = wd.alarm!; wd.alarm = null;
      const r = await core.watchdog();
      expect(r.again).toBe(true);
      expect(wd.alarm).toBe(clock.t + WATCHDOG_EVERY_MS);
    }
    expect(snapCalls()).toBe(3);
    expect(wd.saved).toEqual({ status: "live", watchdogDue: wd.alarm });
  });

  it("arms on host auth", async () => {
    const { clock, host, wd } = setup();
    await host();
    await clock.advance(10);
    expect(wd.alarm).not.toBeNull();
  });

  it("a phase change nudges players and hosts", async () => {
    const { clock, core, player, fix, host, setSnap, wd } = setup();
    const a = await player(1);
    await fix(a);
    await clock.advance(60);
    const h = await host();
    await clock.advance(10);
    const pushes = hostMsgs(h).length;
    setSnap(async () => ({ ok: true, status: "breather", hint_all: true }));
    clock.t = wd.alarm!; wd.alarm = null;
    await core.watchdog();
    await settle();
    expect(hints(a).length).toBeGreaterThanOrEqual(1);
    expect(hostMsgs(h).length).toBeGreaterThan(pushes);
    expect(core.stats().watchdogHints).toBe(1);
    expect(wd.alarm).not.toBeNull();
  });

  it("stops on lobby", async () => {
    const { clock, core, player, fix, setSnap, wd } = setup();
    await fix(await player(1));
    await clock.advance(60);
    setSnap(async () => ({ ok: true, status: "lobby" }));
    clock.t = wd.alarm!; wd.alarm = null;
    expect((await core.watchdog()).again).toBe(false);
    expect(wd.alarm).toBeNull();
  });

  it("ends the room and wipes when the snapshot is ended", async () => {
    const { clock, core, player, fix, setSnap, wd } = setup();
    const a = await player(1);
    await fix(a);
    await clock.advance(60);
    setSnap(async () => ({ ok: true, status: "ended" }));
    clock.t = wd.alarm!; wd.alarm = null;
    expect((await core.watchdog()).again).toBe(false);
    expect(core.isEnded).toBe(true);
    expect(wd.wiped).toBe(true);
    expect(a.closed?.code).toBe(CLOSE.ended);
    expect((await core.watchdog()).again).toBe(false);
  });

  it("keeps watching after a database error and stores no positions", async () => {
    const { clock, core, player, fix, setSnap, wd } = setup();
    await fix(await player(1));
    await clock.advance(60);
    setSnap(async () => {
      throw new Error("down");
    });
    clock.t = wd.alarm!; wd.alarm = null;
    expect((await core.watchdog()).again).toBe(true);
    expect(Object.keys(wd.saved ?? {}).sort()).toEqual(["status", "watchdogDue"]);
  });

  it("restoreState resumes the stored status", async () => {
    const { core, setSnap } = setup();
    core.restoreState({ status: "live", watchdogDue: null });
    setSnap(async () => ({ ok: true, status: "paused" }));
    expect((await core.watchdog()).again).toBe(false);
    expect(core.stats().status).toBe("paused");
  });
});
