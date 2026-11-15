import { afterEach, describe, expect, it, vi } from "vitest";

import { percentile, startSwarm, summarize, type Transport } from "@/lib/sim/driver";

describe("percentile", () => {
  it("handles empty and ordered data", () => {
    expect(percentile([], 95)).toBe(0);
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(xs, 50)).toBe(51);
    expect(percentile(xs, 95)).toBe(96);
  });
});

// A fake server: one session, records calls, raises the alarm the teacher would see.
function fakeServer() {
  const calls: string[] = [];
  const alarms: Array<{ player_id: string; kind: string; resolved: boolean; created_at: string }> = [];
  const square = [[10.75, 59.91], [10.7518, 59.91], [10.7518, 59.9109], [10.75, 59.9109], [10.75, 59.91]];
  const t: Transport = {
    async post(path, body) {
      calls.push(path);
      const b = body as Record<string, unknown>;
      if (path === "/api/join") return { status: 200, data: { sessionId: "s1", playerId: `p${calls.length}`, token: "x".repeat(43) } };
      if (path.endsWith("/me")) return { status: 200, data: { geo: { boundary: { coordinates: [square] }, forbidden: null, assembly: { lat: 59.91045, lng: 10.7509 } } } };
      if (path.endsWith("/sos")) {
        alarms.push({ player_id: String(b.playerId), kind: "sos", resolved: false, created_at: new Date().toISOString() });
        return { status: 200, data: {} };
      }
      if (path.endsWith("/tick")) return { status: 200, data: { safety: { geofence: 0, forbidden: false } } };
      if (path.endsWith("/snapshot")) return { status: 200, data: { alarms } };
      return { status: 404, data: {} };
    },
  };
  return { t, calls };
}

describe("startSwarm", () => {
  afterEach(() => vi.useRealTimers());

  it("joins, ticks on a staggered schedule and measures SOS → teacher latency", async () => {
    vi.useFakeTimers();
    const { t, calls } = fakeServer();
    const s = startSwarm({ transport: t, pin: "123456", kinds: ["runner", "sos"], seed: 1, hostToken: "h".repeat(43), sosAfterS: 4 });
    await s.ready;
    await vi.advanceTimersByTimeAsync(10_000);
    s.stop();
    expect(calls.filter((c) => c === "/api/join")).toHaveLength(2);
    expect(calls.filter((c) => c.endsWith("/tick")).length).toBeGreaterThanOrEqual(8);
    const sum = summarize(s.stats);
    expect(sum.alarms.expected).toBe(1);
    expect(sum.alarms.seen).toBe(1);
    expect(sum.alarms.maxDelayS).toBeLessThanOrEqual(1.1);
  });
});

// ── ws transport ──
import type { WsLike } from "@/lib/sim/ws";

class FakeWs implements WsLike {
  static all: FakeWs[] = [];
  static mode: "ok" | "4410" = "ok";
  readyState = 0;
  sent: string[] = [];
  onopen: WsLike["onopen"] = null;
  onmessage: WsLike["onmessage"] = null;
  onclose: WsLike["onclose"] = null;
  onerror: WsLike["onerror"] = null;
  constructor(public url: string) {
    FakeWs.all.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.({});
    }, 5);
  }
  send(d: string) {
    this.sent.push(d);
    const m = JSON.parse(d) as { t: string; role?: string };
    if (m.t === "auth") {
      if (FakeWs.mode === "4410") setTimeout(() => this.close(4410), 1);
      else setTimeout(() => this.onmessage?.({ data: JSON.stringify({ t: "ready", role: m.role, server_now: "x" }) }), 1);
    } else if (m.t === "fix") {
      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ t: "view", v: { status: "live", safety: {} } }) }), 30);
    }
  }
  close(code = 1005) {
    this.readyState = 3;
    setTimeout(() => this.onclose?.({ code }), 1);
  }
}

describe("startSwarm over ws", () => {
  afterEach(() => vi.useRealTimers());
  const base = () => {
    const { t, calls } = fakeServer();
    const post = t.post;
    t.post = async (path, body) => (path.endsWith("/me") ? { status: 200, data: { ...(await post(path, body)).data, live: { path: "/live/s/s1/ws" } } } : post(path, body));
    return { t, calls };
  };

  it("fails fast when the server has no live transport", async () => {
    const { t } = fakeServer();
    const s = startSwarm({ transport: t, pin: "1", kinds: ["runner"], seed: 1, ws: { base: "ws://x", impl: FakeWs } });
    await expect(s.ready).rejects.toThrow(/LIVE_TRANSPORT=http/);
    s.stop();
  });

  it("sends fixes over the socket, measures fix → view and reconnects after kill", async () => {
    vi.useFakeTimers();
    FakeWs.all = [];
    FakeWs.mode = "ok";
    const { t, calls } = base();
    const s = startSwarm({ transport: t, pin: "1", kinds: ["runner", "runner"], seed: 1, ws: { base: "ws://h:1", impl: FakeWs, iphoneFraction: 0 } });
    await s.ready;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeWs.all[0].url).toBe("ws://h:1/live/s/s1/ws");
    const w = summarize(s.stats).ws!;
    expect(w.fixView.n).toBeGreaterThanOrEqual(6);
    expect(w.fixView.p50).toBe(30);
    // after the first connect ticks go over ws, not HTTP
    expect(calls.filter((c) => c.endsWith("/tick")).length).toBeLessThanOrEqual(2);
    s.kill();
    await vi.advanceTimersByTimeAsync(3000);
    const w2 = summarize(s.stats).ws!;
    expect(w2.reconnects).toBe(2);
    expect(w2.kill?.recoveryS).not.toBeNull();
    expect(w2.kill!.recoveryS!).toBeLessThan(2);
    s.stop();
  });

  it("stops a bot cleanly on a terminal close and does not reconnect", async () => {
    vi.useFakeTimers();
    FakeWs.all = [];
    FakeWs.mode = "4410";
    const { t } = base();
    const s = startSwarm({ transport: t, pin: "1", kinds: ["runner"], seed: 1, ws: { base: "ws://h:1", impl: FakeWs } });
    await s.ready;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(FakeWs.all).toHaveLength(1);
    expect(summarize(s.stats).ws!.terminal).toEqual({ 4410: 1 });
    s.stop();
  });
});
