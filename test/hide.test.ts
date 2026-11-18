import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_PLAN, normPlan, withPractice } from "@/lib/rules/game";
import { HIDE, hideHunters, hidePodiums, hidePoints, hideReleased, minRoundS, validHeadStart } from "@/lib/rules/hide";
import { HOTCOLD, cooldownLeftS, cooldownS, hotColdCheck } from "@/lib/rules/hotcold";

const sql = readFileSync(new URL("../supabase/migrations/0023_hide_seek.sql", import.meta.url), "utf8");

describe("HIDE twin of chase.kv()", () => {
  const body = sql.slice(sql.indexOf("function chase.kv("), sql.indexOf("end::real;", sql.indexOf("function chase.kv(")));
  const pairs = [...body.matchAll(/when '([a-z0-9_]+)'\s+then ([0-9.]+)/g)].map((m) => [m[1], Number(m[2])] as const);
  it("has exactly the same keys and values as the SQL", () => {
    expect(pairs.length).toBe(Object.keys(HIDE).length);
    expect(Object.fromEntries(pairs)).toEqual(HIDE);
  });
});

// Same vectors as test/sql/0023_hide_seek.test.sql.
describe("Gjemsel rules", () => {
  it("hunters = ceil(n / 6), at least one", () => {
    expect([0, 1, 2, 6, 7, 12, 13, 40, 300].map(hideHunters)).toEqual([1, 1, 1, 1, 2, 2, 3, 7, 50]);
  });
  it("ten points per whole minute hidden", () => {
    expect([-5, 0, 59.9, 60, 119, 120, 305].map(hidePoints)).toEqual([0, 0, 0, 10, 10, 20, 50]);
  });
  it("released", () => {
    expect(hideReleased(null, 1000)).toBe(false);
    expect(hideReleased(1000, 1000)).toBe(true);
    expect(hideReleased(1001, 1000)).toBe(false);
  });
  it("the pling circle contains the shifted-from point (offset < radius)", () => {
    expect(HIDE.still_off_max_m).toBeLessThan(HIDE.still_r_m);
    expect(HIDE.still_off_min_m).toBeGreaterThan(0);
  });
  it("hotcold: hunters only in Gjemsel, 30 s cooldown (60 s in Smittejakt)", () => {
    expect(hotColdCheck("sniff", "tag", "hunter", "hide")).toBeNull();
    expect(hotColdCheck("sniff", "tag", "prey", "hide")).toBe("not_useful");
    expect(hotColdCheck("sniff", "tag", "prey", "convert")).toBeNull();
    expect(hotColdCheck("sniff", "tag", "prey")).toBeNull();
    expect(cooldownS("hide")).toBe(30);
    expect(cooldownS("convert")).toBe(HOTCOLD.cooldown_s);
    expect(cooldownLeftS(0, 10_000, cooldownS("hide"))).toBe(20);
    expect(cooldownLeftS(0, 10_000)).toBe(50);
  });
  it("podium goes before Orienterer / points", () => {
    const pods = [{ cat: "distance_m", entries: [] }, { cat: "scoreo", entries: [] }, { cat: "points", entries: [] }];
    const rows = [{ id: "b", hide: 90 }, { id: "a", hide: 90 }, { id: "c", hide: 0 }, { id: "d", hide: 10 }];
    expect(hidePodiums(pods, rows)).toEqual([
      { cat: "distance_m", entries: [] },
      { cat: "hide", entries: [{ id: "a", value: 90 }, { id: "b", value: 90 }, { id: "d", value: 10 }] },
      { cat: "scoreo", entries: [] },
      { cat: "points", entries: [] },
    ]);
    expect(hidePodiums([{ cat: "points", entries: [] }], [{ id: "c", hide: 0 }])).toEqual([{ cat: "points", entries: [] }]);
  });
  it("head start choices and the minimum round", () => {
    expect([59, 60, 75, 90, 91, 75.5, "75", null].map(validHeadStart)).toEqual([false, true, true, true, false, false, false, false]);
    expect(minRoundS(75)).toBe(135);
  });
});

describe("Gjemsel plans (same as test/sql/0023_hide_seek.test.sql)", () => {
  const hide = (r: object) => normPlan({ rounds: [{ mode: "tag", variant: "hide", duration_s: 300, ...r } as never] });
  it("default head start 75 s, explicit 60/90", () => {
    expect(hide({})?.rounds[0]).toEqual({ mode: "tag", variant: "hide", duration_s: 300, head_start_s: 75 });
    expect(hide({ head_start_s: 60, duration_s: 240 })?.rounds[0]).toEqual({ mode: "tag", variant: "hide", duration_s: 240, head_start_s: 60 });
    expect(hide({ head_start_s: 90 })?.rounds[0].head_start_s).toBe(90);
  });
  it("rejects bad head starts and short rounds", () => {
    expect(hide({ head_start_s: 59 })).toBeNull();
    expect(hide({ head_start_s: 91 })).toBeNull();
    expect(hide({ head_start_s: 75.5 })).toBeNull();
    expect(hide({ head_start_s: "75" })).toBeNull();
    expect(hide({ duration_s: 134 })).toBeNull();
    expect(hide({ duration_s: 135 })).not.toBeNull();
  });
  it("no zone, team or prøverunde; head start only on Gjemsel", () => {
    expect(hide({ zone: true })).toBeNull();
    expect(hide({ team: true })).toBeNull();
    expect(hide({ practice: true })).toBeNull();
    expect(normPlan({ rounds: [{ mode: "tag", variant: "convert", duration_s: 300, head_start_s: 75 } as never] })).toBeNull();
    expect(normPlan({ rounds: [{ mode: "posts", duration_s: 300, head_start_s: 75 } as never] })).toBeNull();
    expect(normPlan({ rounds: [{ mode: "tag", variant: "convert", duration_s: 300, practice: true }] })).not.toBeNull();
  });
  it("prøverunde in front of a Gjemsel playlist is a Smittejakt-prøve", () => {
    const p = withPractice({ ...DEFAULT_PLAN, rounds: [{ mode: "tag", variant: "hide", duration_s: 300, head_start_s: 75 }] });
    expect(p.rounds[0]).toEqual({ mode: "tag", variant: "convert", duration_s: 60, practice: true });
    expect(normPlan(p)).not.toBeNull();
  });
});
