import { describe, expect, it } from "vitest";

import { planHasEvents, planHasTeamRound } from "@/lib/client/hostPlan";
import type { Plan } from "@/lib/rules/game";

const base = (over: Partial<Plan>): Plan => ({ rounds: [{ mode: "posts", duration_s: 360 }], ...over }) as Plan;

describe("planHasEvents", () => {
  it("er av uten event_every_s", () => {
    expect(planHasEvents(base({}))).toBe(false);
    expect(planHasEvents(base({ event_every_s: 0 }))).toBe(false);
    expect(planHasEvents(null)).toBe(false);
  });
  it("er på når event_every_s > 0", () => {
    expect(planHasEvents(base({ event_every_s: 90 }))).toBe(true);
  });
});

describe("planHasTeamRound", () => {
  it("individuell plan har ingen lagrunde", () => {
    expect(planHasTeamRound(base({}))).toBe(false);
    expect(planHasTeamRound(undefined)).toBe(false);
  });
  it("team-bryter, flagg, konge og stafett er lagrunder", () => {
    expect(planHasTeamRound(base({ rounds: [{ mode: "posts", duration_s: 360, team: true }] }))).toBe(true);
    expect(planHasTeamRound(base({ rounds: [{ mode: "flag", duration_s: 360 }] }))).toBe(true);
    expect(planHasTeamRound(base({ rounds: [{ mode: "king", duration_s: 360 }] }))).toBe(true);
    expect(planHasTeamRound(base({ teams: 3 }))).toBe(true);
  });
});
