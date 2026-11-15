import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CLOSE } from "@/lib/live/protocol";
import {
  LiveSocket,
  backoffMs,
  fixDelayMs,
  hostPollDue,
  mergeHostPush,
  type LiveState,
  type WsLike,
} from "@/lib/client/live";

class FakeWs implements WsLike {
  static all: FakeWs[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: WsLike["onopen"] = null;
  onmessage: WsLike["onmessage"] = null;
  onclose: WsLike["onclose"] = null;
  onerror: WsLike["onerror"] = null;
  constructor(public url: string) {
    FakeWs.all.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  recv(d: string) {
    this.onmessage?.({ data: d });
  }
  drop(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const AUTH = { t: "auth", role: "player", playerId: "11111111-1111-4111-8111-111111111111", token: "SECRETTOKEN" } as const;
const READY = JSON.stringify({ t: "ready", role: "player", server_now: "x" });

function make() {
  const states: [LiveState, { code?: number; terminal?: boolean } | undefined][] = [];
  const msgs: unknown[] = [];
  const s = new LiveSocket({
    path: "/live/s/abc/ws",
    auth: AUTH,
    base: "ws://127.0.0.1:8787",
    WebSocketImpl: FakeWs,
    onMsg: (m) => msgs.push(m),
    onState: (st, d) => states.push([st, d]),
  });
  return { s, states, msgs, ws: () => FakeWs.all[FakeWs.all.length - 1]! };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  FakeWs.all = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("LiveSocket", () => {
  it("sends auth as the first frame and keeps the token out of the URL", () => {
    const { ws } = make();
    expect(ws().url).toBe("ws://127.0.0.1:8787/live/s/abc/ws");
    expect(ws().url).not.toContain("SECRETTOKEN");
    ws().open();
    expect(JSON.parse(ws().sent[0]!)).toEqual(AUTH);
  });

  it("is ready only after the ready frame; send is false before", () => {
    const { s, ws } = make();
    expect(s.send({ lat: 59, lng: 10, acc: 5, speed: null })).toBe(false);
    ws().open();
    expect(s.send({ lat: 59, lng: 10, acc: 5, speed: null })).toBe(false);
    ws().recv(READY);
    expect(s.state).toBe("ready");
    expect(s.send({ lat: 59, lng: 10, acc: 5, speed: null })).toBe(true);
    expect(JSON.parse(ws().sent.at(-1)!)).toMatchObject({ t: "fix", lat: 59 });
  });

  it("answers silence: pings every 5 s, reconnects after 7 s without any frame", () => {
    const { ws } = make();
    ws().open();
    ws().recv(READY);
    vi.advanceTimersByTime(5000);
    expect(ws().sent.at(-1)).toBe("ping");
    ws().recv("pong");
    vi.advanceTimersByTime(6900);
    expect(FakeWs.all).toHaveLength(1);
    vi.advanceTimersByTime(200); // 7 s since the pong
    vi.advanceTimersByTime(600); // backoff 0.5 s
    expect(FakeWs.all).toHaveLength(2);
  });

  it("backs off 0.5 -> 8 s and resets on ready", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(backoffMs)).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000]);
    make();
    const last = () => FakeWs.all[FakeWs.all.length - 1]!;
    last().drop(1006);
    vi.advanceTimersByTime(499);
    expect(FakeWs.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWs.all).toHaveLength(2);
    last().drop(1006);
    vi.advanceTimersByTime(999);
    expect(FakeWs.all).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWs.all).toHaveLength(3);
    last().open();
    last().recv(READY);
    last().drop(1006); // reset: back to 0.5 s
    vi.advanceTimersByTime(500);
    expect(FakeWs.all).toHaveLength(4);
  });

  it.each([CLOSE.ended, CLOSE.kicked, CLOSE.not_found, CLOSE.auth])("does not reconnect on terminal code %i", (code) => {
    const { states, ws } = make();
    ws().open();
    ws().drop(code);
    vi.advanceTimersByTime(60_000);
    expect(FakeWs.all).toHaveLength(1);
    expect(states.at(-1)).toEqual(["closed", { code, terminal: true }]);
  });

  it("goes disabled on 4003 and stays there", () => {
    const { s, states, ws } = make();
    ws().drop(CLOSE.disabled);
    vi.advanceTimersByTime(60_000);
    expect(FakeWs.all).toHaveLength(1);
    expect(s.state).toBe("disabled");
    expect(states.at(-1)?.[1]).toEqual({ code: CLOSE.disabled, terminal: true });
    expect(s.send({ lat: 1, lng: 1, acc: 1, speed: null })).toBe(false);
  });

  it("close() stops reconnecting", () => {
    const { s, ws } = make();
    const w = ws();
    s.close();
    w.drop(1006);
    vi.advanceTimersByTime(60_000);
    expect(FakeWs.all).toHaveLength(1);
  });
});

describe("pure helpers", () => {
  it("fixDelayMs keeps fixes >= 1.9 s apart", () => {
    expect(fixDelayMs(1000, null)).toBe(0);
    expect(fixDelayMs(2000, 1000)).toBe(900);
    expect(fixDelayMs(3000, 1000)).toBe(0);
  });

  it("hostPollDue: fast polling unless pushes arrive, then a 10 s watchdog", () => {
    const base = { wsReady: true, lastPushAt: 1000, lastHttpAt: 1000, now: 3000 };
    expect(hostPollDue(base)).toBe(false);
    expect(hostPollDue({ ...base, now: 11_000, lastPushAt: 10_000 })).toBe(true); // watchdog
    expect(hostPollDue({ ...base, now: 8000 })).toBe(true); // push stale (>6 s)
    expect(hostPollDue({ ...base, wsReady: false })).toBe(true);
    expect(hostPollDue({ ...base, lastPushAt: null })).toBe(true);
  });

  it("mergeHostPush keeps geo and live from the last snapshot", () => {
    const prev = { geo: { a: 1 }, live: { path: "/p" }, pin: "1", status: "live" };
    const out = mergeHostPush(prev, { status: "paused", geo: null, live: null });
    expect(out).toEqual({ geo: { a: 1 }, live: { path: "/p" }, pin: "1", status: "paused" });
  });
});
