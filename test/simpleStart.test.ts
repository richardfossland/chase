import { describe, expect, it } from "vitest";
import { TEMPLATES, hasPractice, normPlan, planTotalS, withPractice, type Plan } from "@/lib/rules/game";
import { STARTER_PACKS } from "@/lib/starter";
import { usesHiddenModes } from "@/lib/client/visibleModes";

describe("enkel start: maler", () => {
  const base = (n: number, d: number) => 10 * n + (n - 1) * 60 + n * d;
  it("postjakt, smittejakt og gjemsel passerer normPlan uendret", () => {
    for (const id of ["postjakt", "smittejakt", "gjemsel"] as const) expect(normPlan(TEMPLATES[id])).toEqual(TEMPLATES[id]);
  });
  it("3 runder, pustepause 60 s, ingen hendelser/quiz/oppdrag/prøverunde", () => {
    for (const id of ["postjakt", "smittejakt", "gjemsel"] as const) {
      const p: Plan = TEMPLATES[id];
      expect(p.rounds).toHaveLength(3);
      expect(p.breather_s).toBe(60);
      expect(p.event_every_s).toBeUndefined();
      expect(p.quiz).toBeUndefined();
      expect(p.missions).toBeUndefined();
      expect(p.teams).toBeUndefined();
      expect(hasPractice(p)).toBe(false);
      expect(p.rounds.every((r) => !r.zone && !r.team)).toBe(true);
    }
  });
  it("modus og varighet", () => {
    expect(TEMPLATES.postjakt.rounds.map((r) => [r.mode, r.duration_s])).toEqual([["posts", 360], ["posts", 360], ["posts", 360]]);
    expect(planTotalS(TEMPLATES.postjakt)).toBe(3 * 360 + 3 * 10 + 2 * 60);
    expect(TEMPLATES.smittejakt.rounds.every((r) => r.mode === "tag" && r.variant === "convert" && r.duration_s === 300)).toBe(true);
    expect(planTotalS(TEMPLATES.smittejakt)).toBe(base(3, 300));
    expect(TEMPLATES.gjemsel.rounds.every((r) => r.mode === "tag" && r.variant === "hide" && r.head_start_s === 75 && r.duration_s === 300)).toBe(true);
    expect(planTotalS(TEMPLATES.gjemsel)).toBe(base(3, 300));
  });
  it("prøverunde kan fortsatt slås på (Gjemsel får Smittejakt-prøve)", () => {
    for (const id of ["postjakt", "smittejakt", "gjemsel"] as const) {
      const p = withPractice(TEMPLATES[id]);
      expect(hasPractice(p)).toBe(true);
      expect(normPlan(p)).not.toBeNull();
    }
  });
});

describe("enkel start: skjulte moduser", () => {
  const r = (x: object) => ({ rounds: [{ duration_s: 300, ...x }] }) as Plan;
  it("synlige moduser åpner ikke Flere moduser", () => {
    for (const x of [{ mode: "posts" }, { mode: "tag", variant: "convert" }, { mode: "tag" }, { mode: "tag", variant: "hide" }, { mode: "flag" }, { mode: "posts", team: true, zone: true }]) {
      expect(usesHiddenModes(r(x))).toBe(false);
    }
    for (const id of ["postjakt", "smittejakt", "gjemsel"] as const) expect(usesHiddenModes(TEMPLATES[id])).toBe(false);
  });
  it("skjulte moduser og varianter åpner Flere moduser", () => {
    for (const x of [{ mode: "free" }, { mode: "tag", variant: "swap" }, { mode: "tag", variant: "fox" }, { mode: "king" }, { mode: "relay" }, { mode: "scoreo" }]) {
      expect(usesHiddenModes(r(x))).toBe(true);
    }
  });
  it("ett skjult runde blant synlige er nok", () => {
    expect(usesHiddenModes({ rounds: [...TEMPLATES.postjakt.rounds, { mode: "relay", duration_s: 300 }] })).toBe(true);
    expect(usesHiddenModes(TEMPLATES.gym)).toBe(true);
    expect(usesHiddenModes(TEMPLATES.teams)).toBe(true);
    expect(STARTER_PACKS.some((p) => usesHiddenModes(p.plan))).toBe(true);
  });
});
