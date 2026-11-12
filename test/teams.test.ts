import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normPlan } from "@/lib/rules/game";
import { TEAMS, captureLeftS, isTeamRound, teamMajority, teamPick, teamPodiums, teamSnake } from "@/lib/rules/teams";

const sql = readFileSync(new URL("../supabase/migrations/0009_teams_flag_king.sql", import.meta.url), "utf8");

describe("TEAMS twin of chase.kl()", () => {
  const body = sql.slice(sql.indexOf("function chase.kl("), sql.indexOf("end::real;", sql.indexOf("function chase.kl(")));
  const pairs = [...body.matchAll(/when '([a-z0-9_]+)'\s+then ([0-9.]+)/g)].map((m) => [m[1], Number(m[2])] as const);
  it("has exactly the same keys and values as the SQL", () => {
    expect(pairs.length).toBe(Object.keys(TEAMS).length);
    expect(Object.fromEntries(pairs)).toEqual(TEAMS);
  });
});

// Same vectors as test/sql/0009_teams_flag_king.test.sql.
describe("team rules", () => {
  it("snake draft", () => {
    expect([0, 1, 2, 3, 4, 5].map((i) => teamSnake(i, 2))).toEqual([1, 2, 2, 1, 1, 2]);
    expect([0, 1, 2, 3, 4, 5].map((i) => teamSnake(i, 3))).toEqual([1, 2, 3, 3, 2, 1]);
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => teamSnake(i, 4))).toEqual([1, 2, 3, 4, 4, 3, 2, 1, 1]);
  });
  it("snake keeps sizes within one", () => {
    for (const n of [2, 3, 4]) {
      for (let players = 1; players <= 40; players++) {
        const sizes = Array(n).fill(0);
        for (let i = 0; i < players; i++) sizes[teamSnake(i, n) - 1]++;
        expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
      }
    }
  });
  it("strict majority", () => {
    expect(teamMajority([3, 1])).toBe(1);
    expect(teamMajority([2, 2])).toBeNull();
    expect(teamMajority([0, 0])).toBeNull();
    expect(teamMajority([1, 2, 2])).toBeNull();
    expect(teamMajority([0, 3, 1, 0])).toBe(2);
    expect(teamMajority([])).toBeNull();
  });
  it("late joiner pick", () => {
    expect(teamPick([3, 2, 2], [0, 50, 10])).toBe(3);
    expect(teamPick([2, 2], [10, 10])).toBe(1);
    expect(teamPick([1, 2], [99, 0])).toBe(1);
  });
  it("team rounds", () => {
    expect(isTeamRound({ mode: "flag" }) && isTeamRound({ mode: "king" }) && isTeamRound({ mode: "posts", team: true })).toBe(true);
    expect(isTeamRound({ mode: "posts" }) || isTeamRound({ mode: "tag" }) || isTeamRound(null)).toBe(false);
  });
  it("podiums", () => {
    expect(
      teamPodiums(
        [{ cat: "posts", entries: [{ id: "a", value: 4 }] }, { cat: "points", entries: [{ id: "c", value: 90 }] }],
        [{ id: "t1", n: 1, points: 50 }, { id: "t2", n: 2, points: 80 }],
        [{ id: "a", teamplay: 3 }, { id: "b", teamplay: 0 }, { id: "c", teamplay: 5 }, { id: "d", teamplay: 3 }],
      ),
    ).toEqual([
      { cat: "posts", entries: [{ id: "a", value: 4 }] },
      { cat: "teamplay", entries: [{ id: "c", value: 5 }, { id: "a", value: 3 }, { id: "d", value: 3 }] },
      { cat: "points", entries: [{ id: "c", value: 90 }] },
      { cat: "team", entries: [{ id: "t2", value: 80 }, { id: "t1", value: 50 }] },
    ]);
    expect(teamPodiums([{ cat: "posts", entries: [{ id: "a", value: 4 }] }], [{ id: "t1", n: 1, points: 10 }, { id: "t2", n: 2, points: 10 }], [{ id: "a", teamplay: 0 }])).toEqual([
      { cat: "posts", entries: [{ id: "a", value: 4 }] },
      { cat: "team", entries: [{ id: "t1", value: 10 }, { id: "t2", value: 10 }] },
    ]);
    expect(teamPodiums([{ cat: "posts", entries: [] }], [{ id: "t1", n: 1, points: 10 }], [])).toEqual([{ cat: "posts", entries: [] }]);
  });
  it("capture countdown", () => {
    const at = Date.parse("2026-11-12T10:00:00Z");
    expect(captureLeftS(null, 0, at)).toBeNull();
    expect(captureLeftS("2026-11-12T10:00:00Z", 0, at + 3200)).toBe(7);
    expect(captureLeftS("2026-11-12T10:00:00Z", 0, at + 60_000)).toBe(0);
    expect(captureLeftS("2026-11-12T10:00:00Z", 0, at + 60_000, "2026-11-12T10:00:04Z")).toBe(6);
  });
});

describe("normPlan with teams", () => {
  it("same vectors as the SQL", () => {
    expect(normPlan({ rounds: [{ mode: "flag", duration_s: 300 }] })).toMatchObject({ rounds: [{ mode: "flag", duration_s: 300 }], teams: 2 });
    expect(normPlan({ rounds: [{ mode: "king", duration_s: 300 }], teams: 4 })?.teams).toBe(4);
    const p = normPlan({ rounds: [{ mode: "posts", duration_s: 300, team: true }, { mode: "tag", duration_s: 300 }], teams: 3 });
    expect(p?.rounds[0].team).toBe(true);
    expect(p?.rounds[1].team).toBeUndefined();
    expect(p?.teams).toBe(3);
    expect(normPlan({ rounds: [{ mode: "tag", duration_s: 300, team: true }] })).toBeNull();
    expect(normPlan({ rounds: [{ mode: "flag", duration_s: 300, zone: true }] })).toBeNull();
    expect(normPlan({ rounds: [{ mode: "flag", duration_s: 300 }], teams: 5 })).toBeNull();
    expect(normPlan({ rounds: [{ mode: "flag", duration_s: 300 }], teams: 1 })).toBeNull();
    expect(normPlan({ rounds: [{ mode: "flag", duration_s: 300 }], teams: "2" as never })).toBeNull();
    expect(normPlan({ rounds: [{ mode: "posts", duration_s: 300, team: "yes" as never }] })).toBeNull();
    const q = normPlan({ rounds: [{ mode: "posts", duration_s: 300, team: false }], teams: 3 });
    expect(q?.teams).toBeUndefined();
    expect(q?.rounds[0].team).toBeUndefined();
    expect(normPlan({ rounds: [{ mode: "flag", duration_s: 30 }] })).toBeNull();
    expect(normPlan({ rounds: [{ mode: "king", duration_s: 300 }], event_every_s: 90 })?.event_every_s).toBe(90);
  });
});
