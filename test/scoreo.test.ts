import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_PLAN, TEMPLATES, hasPractice, normPlan, planTotalS, withPractice, withoutPractice } from "@/lib/rules/game";
import { eventKinds } from "@/lib/rules/events";
import { SCOREO, scoreoPenalty, scoreoPodiums, scoreoValue } from "@/lib/rules/scoreo";

const sql = readFileSync(new URL("../supabase/migrations/0020_practice_scoreo.sql", import.meta.url), "utf8");

describe("SCOREO twin of chase.ks()", () => {
  const body = sql.slice(sql.indexOf("function chase.ks("), sql.indexOf("end::real;", sql.indexOf("function chase.ks(")));
  const pairs = [...body.matchAll(/when '([a-z0-9_]+)'\s+then ([0-9.]+)/g)].map((m) => [m[1], Number(m[2])] as const);
  it("has exactly the same keys and values as the SQL", () => {
    expect(pairs.length).toBe(Object.keys(SCOREO).length);
    expect(Object.fromEntries(pairs)).toEqual(SCOREO);
  });
});

// Same vectors as test/sql/0020_practice_scoreo.test.sql.
describe("score-O rules", () => {
  it("value bands", () => {
    expect([0, 24.9, 25, 49.9, 50, 74.9, 75, 100, 150, -5].map((d) => scoreoValue(d, 100))).toEqual([10, 10, 20, 20, 30, 30, 40, 40, 40, 10]);
  });
  it("penalty per started 10 s, capped at the round's points", () => {
    const v: [number, number][] = [[0, 50], [-3, 50], [0.1, 50], [10, 50], [10.1, 50], [25, 50], [95, 50], [200, 30], [30, 0], [30, 7]];
    expect(v.map(([l, b]) => scoreoPenalty(l, b))).toEqual([0, 0, 5, 5, 10, 15, 50, 30, 0, 7]);
    expect(scoreoPenalty(null, 50)).toBe(0);
  });
  it("events: no sprint or gathering in score-O", () => {
    expect(eventKinds("scoreo", false, true)).toEqual([]);
    expect(eventKinds("scoreo", false, false)).toEqual(["mission"]);
    expect(eventKinds("posts", false, true)).toEqual(["sprint", "gather"]);
  });
  it("podium goes before points", () => {
    const pods = [{ cat: "distance_m", entries: [] }, { cat: "points", entries: [] }];
    const rows = [{ id: "b", so: 40 }, { id: "a", so: 40 }, { id: "c", so: 0 }, { id: "d", so: 10 }];
    expect(scoreoPodiums(pods, rows)).toEqual([
      { cat: "distance_m", entries: [] },
      { cat: "scoreo", entries: [{ id: "a", value: 40 }, { id: "b", value: 40 }, { id: "d", value: 10 }] },
      { cat: "points", entries: [] },
    ]);
    expect(scoreoPodiums([{ cat: "points", entries: [] }], [{ id: "c", so: 0 }])).toEqual([{ cat: "points", entries: [] }]);
  });
  it("plans", () => {
    const p = normPlan({ rounds: [{ mode: "posts", duration_s: 60, practice: true }, { mode: "scoreo", duration_s: 300 }, { mode: "tag", variant: "swap", duration_s: 60, practice: true }] });
    expect(p?.rounds).toEqual([
      { mode: "posts", duration_s: 60, practice: true },
      { mode: "scoreo", duration_s: 300 },
      { mode: "tag", duration_s: 60, variant: "swap", practice: true },
    ]);
    expect(p?.teams).toBeUndefined();
    const f = normPlan({ rounds: [{ mode: "posts", duration_s: 300 }, { mode: "free", duration_s: 300 }] });
    expect(f?.rounds.some((r) => "practice" in r)).toBe(false);
    const bad = (r: object) => normPlan({ rounds: [r as never] });
    expect(bad({ mode: "free", duration_s: 60, practice: true })).toBeNull();
    expect(bad({ mode: "scoreo", duration_s: 300, practice: true })).toBeNull();
    expect(bad({ mode: "posts", duration_s: 60, practice: true, zone: true })).toBeNull();
    expect(bad({ mode: "posts", duration_s: 60, practice: true, team: true })).toBeNull();
    expect(bad({ mode: "posts", duration_s: 60, practice: "yes" })).toBeNull();
    expect(bad({ mode: "scoreo", duration_s: 300, zone: true })).toBeNull();
    expect(bad({ mode: "scoreo", duration_s: 300, team: true })).toBeNull();
    expect(bad({ mode: "scoreo", duration_s: 30 })).toBeNull();
  });
  it("a score-O round also takes the return window of the plan's clock", () => {
    const base = { countdown_s: 10, breather_s: 60, qr_posts: 0 };
    const a = planTotalS({ ...base, rounds: [{ mode: "posts", duration_s: 300 }] });
    const b = planTotalS({ ...base, rounds: [{ mode: "scoreo", duration_s: 300 }] });
    expect(b - a).toBe(SCOREO.so_return_s);
  });
  it("wizard helpers: prøverunde first, in the mode of the first real round", () => {
    const p = withPractice(DEFAULT_PLAN);
    expect(p.rounds[0]).toEqual({ mode: "posts", duration_s: 60, practice: true });
    expect(p.rounds).toHaveLength(DEFAULT_PLAN.rounds.length + 1);
    expect(hasPractice(p) && !hasPractice(DEFAULT_PLAN)).toBe(true);
    expect(withPractice(p)).toBe(p);
    expect(normPlan(p)).not.toBeNull();
    expect(withoutPractice(p)).toEqual(DEFAULT_PLAN);
    const tag = withPractice({ ...TEMPLATES.first, rounds: [{ mode: "tag", variant: "swap", duration_s: 300 }] });
    expect(tag.rounds[0]).toEqual({ mode: "tag", variant: "swap", duration_s: 60, practice: true });
    const full = { ...DEFAULT_PLAN, rounds: Array.from({ length: 10 }, () => ({ mode: "posts" as const, duration_s: 300 })) };
    expect(withPractice(full)).toBe(full);
  });
});
