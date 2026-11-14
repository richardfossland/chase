import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normPlan } from "@/lib/rules/game";
import { eventKinds } from "@/lib/rules/events";
import { RELAY, relayBatons, relayPost } from "@/lib/rules/relay";
import { isTeamRound } from "@/lib/rules/teams";

const sql = readFileSync(new URL("../supabase/migrations/0013_relay_fox_scale.sql", import.meta.url), "utf8");

describe("RELAY twin of chase.k8()", () => {
  const body = sql.slice(sql.indexOf("function chase.k8("), sql.indexOf("end::real;", sql.indexOf("function chase.k8(")));
  const pairs = [...body.matchAll(/when '([a-z0-9_]+)'\s+then ([0-9.]+)/g)].map((m) => [m[1], Number(m[2])] as const);
  it("has exactly the same keys and values as the SQL", () => {
    expect(pairs.length).toBe(Object.keys(RELAY).length);
    expect(Object.fromEntries(pairs)).toEqual(RELAY);
  });
});

// Same vectors as test/sql/0013_relay_fox_scale.test.sql.
describe("relay rules", () => {
  it("batons", () => {
    expect([0, 1, 5, 6, 10, 11, 75].map(relayBatons)).toEqual([0, 1, 1, 2, 2, 3, 15]);
  });
  it("course cycle", () => {
    expect([[1, 0], [2, 0], [4, 3], [1, 7], [3, -1]].map(([n, l]) => relayPost(n, l, 5))).toEqual([0, 1, 1, 2, 1]);
    expect(relayPost(1, 0, 0)).toBeNull();
  });
  it("relay is a team round, fox is not", () => {
    expect(isTeamRound({ mode: "relay" })).toBe(true);
    expect(isTeamRound({ mode: "tag" })).toBe(false);
  });
  it("events in a relay round", () => {
    expect(eventKinds("relay", false, true)).toEqual([]);
    expect(eventKinds("relay", false, false)).toEqual(["mission"]);
    expect(eventKinds("posts", false, true)).toEqual(["sprint", "gather"]);
  });
  it("plans", () => {
    expect(normPlan({ rounds: [{ mode: "relay", duration_s: 300 }] })).toMatchObject({ rounds: [{ mode: "relay", duration_s: 300 }], teams: 2 });
    const p = normPlan({ rounds: [{ mode: "relay", duration_s: 300, team: true }, { mode: "flag", duration_s: 300 }], teams: 3 });
    expect(p?.rounds[0]).toEqual({ mode: "relay", duration_s: 300 });
    expect(p?.teams).toBe(3);
    expect(normPlan({ rounds: [{ mode: "relay", duration_s: 300, zone: true }] })).toBeNull();
    expect(normPlan({ rounds: [{ mode: "relay", duration_s: 300, team: false }] })).toBeNull();
    expect(normPlan({ rounds: [{ mode: "relay", duration_s: 30 }] })).toBeNull();
    const f = normPlan({ rounds: [{ mode: "tag", variant: "fox", duration_s: 300 }] });
    expect(f?.rounds[0]).toEqual({ mode: "tag", variant: "fox", duration_s: 300 });
    expect(f?.teams).toBeUndefined();
    expect(normPlan({ rounds: [{ mode: "tag", variant: "fox", duration_s: 300, team: true }] })).toBeNull();
    expect(normPlan({ rounds: [{ mode: "tag", variant: "fox", duration_s: 300, zone: true }] })?.rounds[0].zone).toBe(true);
  });
});
