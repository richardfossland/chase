import { describe, expect, it } from "vitest";

import { aggregateGate, count5xx, parseArgs, parseSimConfig, WS_GATE, wsGateProblems, type WsGateInput } from "@/lib/sim/cli";
import { diffSnapshots, type DbSnapshot } from "@/lib/sim/dbdiff";
import { percentile } from "@/lib/sim/driver";
import { reconnectDelayMs, toWsBase } from "@/lib/sim/ws";

describe("percentile", () => {
  it("is the nearest-rank on sorted data and 0 for no data", () => {
    expect(percentile([], 99)).toBe(0);
    const xs = Array.from({ length: 200 }, (_, i) => 200 - i);
    expect(percentile(xs, 50)).toBe(101);
    expect(percentile(xs, 99)).toBe(199);
    expect(percentile([5], 99)).toBe(5);
  });
});

describe("flag parsing", () => {
  it("parses values, bare flags and --k=v", () => {
    expect(parseArgs(["--create", "--bots", "60", "--live-ws=ws://127.0.0.1:8787", "--assert"])).toEqual({
      create: true, bots: "60", "live-ws": "ws://127.0.0.1:8787", assert: true,
    });
  });
  it("defaults to http, one session", () => {
    expect(parseSimConfig({})).toEqual({ transport: "http", sessions: 1, killAtS: null, liveWs: null, liveStats: null });
  });
  it("reads the ws flags", () => {
    const c = parseSimConfig(parseArgs(["--transport", "ws", "--sessions", "4", "--kill-at", "90", "--live-stats", "http://127.0.0.1:8787/"]));
    expect(c).toMatchObject({ transport: "ws", sessions: 4, killAtS: 90, liveStats: "http://127.0.0.1:8787" });
  });
  it("rejects bad input", () => {
    expect(() => parseSimConfig({ transport: "udp" })).toThrow();
    expect(() => parseSimConfig({ sessions: "0" })).toThrow();
    expect(() => parseSimConfig({ "kill-at": "30" })).toThrow(/transport ws/);
  });
});

describe("ws helpers", () => {
  it("maps http origins to ws", () => {
    expect(toWsBase("http://localhost:3120")).toBe("ws://localhost:3120");
    expect(toWsBase("https://chase.sundaysuite.app/x")).toBe("wss://chase.sundaysuite.app");
  });
  it("backs off 0.5 → 8 s and never above the cap", () => {
    const mid = () => 0.5;
    expect([0, 1, 2, 3, 4, 5, 9].map((a) => reconnectDelayMs(a, mid))).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000]);
    expect(reconnectDelayMs(20, () => 0.999)).toBeLessThanOrEqual(8000);
    expect(reconnectDelayMs(0, () => 0)).toBe(375);
  });
});

const ok: WsGateInput = { errors5xx: 0, alarmMaxS: 2, alarmP95S: 1, fixViewP95: 400, fixViewP99: 900, fixViewN: 500, killAtS: null, recoveryS: null, missedAlarmsAfterKill: 0 };

describe("ws gate", () => {
  it("passes inside every threshold", () => {
    expect(wsGateProblems(ok)).toEqual([]);
    expect(wsGateProblems({ ...ok, killAtS: 60, recoveryS: 4.2 })).toEqual([]);
  });
  it("flags each breach", () => {
    expect(wsGateProblems({ ...ok, errors5xx: 2 })).toHaveLength(1);
    expect(wsGateProblems({ ...ok, alarmMaxS: WS_GATE.alarmMaxS })).toHaveLength(1);
    expect(wsGateProblems({ ...ok, alarmP95S: 3.1 })).toHaveLength(1);
    expect(wsGateProblems({ ...ok, fixViewP95: 1500, fixViewP99: 3000 })).toHaveLength(2);
    expect(wsGateProblems({ ...ok, fixViewN: 0 })).toHaveLength(1);
    expect(wsGateProblems({ ...ok, killAtS: 60, recoveryS: 10.5 })).toHaveLength(1);
    expect(wsGateProblems({ ...ok, killAtS: 60, recoveryS: null })).toHaveLength(1);
    expect(wsGateProblems({ ...ok, killAtS: 60, recoveryS: 3, missedAlarmsAfterKill: 1 })).toHaveLength(1);
  });
  it("counts only 5xx errors", () => {
    expect(count5xx({ tick_500_x: 2, tick_503_: 1, tick_409_stale: 4, sos_429_x: 1, ws_err_rate: 3 })).toBe(3);
  });
  it("aggregates samples and the slowest recovery over sessions", () => {
    const mk = (fix: number[], rec: number | null) =>
      ({
        errors: {}, alarms: [{ player: "a", kind: "sos", expectedAt: 1000, seenAt: 3000 }],
        ws: { fixView: fix, kill: { at: 10_000, total: 5, recoveredAt: rec === null ? null : 10_000 + rec * 1000 } },
      }) as never;
    const g = aggregateGate([mk([100, 200], 2), mk([300, 4000], 6)], 30);
    expect(g.fixViewN).toBe(4);
    expect(g.recoveryS).toBe(6);
    expect(g.alarmMaxS).toBe(2);
    expect(aggregateGate([mk([1], 2), mk([1], null)], 30).recoveryS).toBeNull();
  });
});

describe("db diff", () => {
  const a: DbSnapshot = {
    takenAt: "2026-11-15T10:00:00Z",
    database: { xact_commit: 1000, xact_rollback: 10, deadlocks: 0, blks_read: 100, blks_hit: 900 },
    functions: [{ name: "chase.tick", calls: 100, total_time: 200, self_time: 150 }],
    statements: null,
  };
  const b: DbSnapshot = {
    takenAt: "2026-11-15T10:00:30Z",
    database: { xact_commit: 1290, xact_rollback: 20, deadlocks: 1, blks_read: 200, blks_hit: 2700 },
    functions: [
      { name: "chase.tick", calls: 400, total_time: 800, self_time: 650 },
      { name: "chase.new_fn", calls: 0, total_time: 0, self_time: 0 },
    ],
    statements: null,
  };
  it("computes per-second rates and tps", () => {
    const d = diffSnapshots(a, b);
    expect(d.seconds).toBe(30);
    expect(d.transactions).toBe(300);
    expect(d.tps).toBe(10);
    expect(d.rollbackPct).toBe(3.33);
    expect(d.perSec.deadlocks).toBe(0.03);
    expect(d.cacheHitPct).toBe(94.74);
    expect(d.functions).toEqual([{ name: "chase.tick", calls: 300, callsPerSec: 10, totalMs: 600, selfMs: 500, avgMs: 2 }]);
    expect(d.statements).toBeNull();
  });
  it("rejects out-of-order snapshots", () => {
    expect(() => diffSnapshots(b, a)).toThrow();
  });
});
