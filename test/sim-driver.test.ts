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
