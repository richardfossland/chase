import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normPlan } from "@/lib/rules/game";
import { QUIZ, normQuiz, parseQuizText, quizPick, quizToText, stepsAccept } from "@/lib/rules/quiz";
import { countSteps } from "@/lib/client/steps";

const sql = readFileSync(new URL("../supabase/migrations/0012_quiz_steps.sql", import.meta.url), "utf8");

describe("QUIZ twin of chase.kq()", () => {
  const body = sql.slice(sql.indexOf("function chase.kq("), sql.indexOf("end::real;", sql.indexOf("function chase.kq(")));
  const pairs = [...body.matchAll(/when '([a-z0-9_]+)'\s+then ([0-9.]+)/g)].map((m) => [m[1], Number(m[2])] as const);
  it("has exactly the same keys and values as the SQL", () => {
    expect(pairs.length).toBe(Object.keys(QUIZ).length);
    expect(Object.fromEntries(pairs)).toEqual(QUIZ);
  });
});

// Same vectors as test/sql/0012_quiz_steps.test.sql.
describe("quiz rules", () => {
  it("normalise", () => {
    expect(normQuiz([{ q: "  Hva er  2+2? ", a: [" 4", "5 "], c: 0 }])).toEqual([{ q: "Hva er 2+2?", a: ["4", "5"], c: 0 }]);
    expect(normQuiz([])).toBeNull();
    expect(normQuiz([{ q: "Hva?", a: ["4"], c: 0 }])).toBeNull();
    expect(normQuiz([{ q: "Hva?", a: ["a", "b", "c", "d", "e"], c: 0 }])).toBeNull();
    expect(normQuiz([{ q: "Hva?", a: ["Ja", "ja"], c: 0 }])).toBeNull();
    expect(normQuiz([{ q: "Hva?", a: ["a", "b"], c: 2 }])).toBeNull();
    expect(normQuiz([{ q: "Hva?", a: ["a", "b"], c: 0.5 }])).toBeNull();
    expect(normQuiz([{ q: "Hv", a: ["a", "b"], c: 0 }])).toBeNull();
    expect(normQuiz([{ q: "Hva?", a: ["a", 3], c: 0 }])).toBeNull();
    expect(normQuiz(Array.from({ length: 31 }, (_, i) => ({ q: `Spørsmål ${i}`, a: ["a", "b"], c: 1 })))).toBeNull();
  });
  it("pick and steps", () => {
    expect([0, 1, 2, 3].map((i) => quizPick(i, 3, 7))).toEqual([1, 2, 0, 1]);
    expect(quizPick(0, 3, -4)).toBe(2);
    expect([stepsAccept(10, 2), stepsAccept(5, 2), stepsAccept(10, null), stepsAccept(-3, 2), stepsAccept(10, 0)]).toEqual([8, 5, 8, 0, 0]);
  });
  it("plan", () => {
    expect(normPlan({ rounds: [{ mode: "posts", duration_s: 300 }], quiz: [{ q: "Hva?", a: ["a", "b"], c: 1 }] })?.quiz?.[0].c).toBe(1);
    expect(normPlan({ rounds: [{ mode: "posts", duration_s: 300 }], quiz: [{ q: "Hva?", a: ["a"], c: 0 }] })).toBeNull();
    expect(normPlan({ rounds: [{ mode: "posts", duration_s: 300 }], quiz: [] })?.quiz).toBeUndefined();
  });
  it("teacher text format round-trips", () => {
    const text = "Hovedstaden i Norge?\nBergen\n*Oslo\nTromsø\n\nHva er 2+2?\n*4\n5";
    const { items, errors } = parseQuizText(text);
    expect(errors).toEqual([]);
    expect(items).toEqual([
      { q: "Hovedstaden i Norge?", a: ["Bergen", "Oslo", "Tromsø"], c: 1 },
      { q: "Hva er 2+2?", a: ["4", "5"], c: 0 },
    ]);
    expect(parseQuizText(quizToText(items)).items).toEqual(items);
    expect(parseQuizText("Uten riktig?\nA\nB\n\nTo riktige?\n*A\n*B").errors).toEqual([1, 2]);
  });
});

describe("step detector", () => {
  it("counts a 2 Hz walk and ignores small jitter", () => {
    const walk = Array.from({ length: 100 }, (_, i) => 9.81 + 3 * Math.sin((2 * Math.PI * 2 * i) / 20)); // 20 Hz, 5 s
    expect(countSteps(walk, 20)).toBeGreaterThanOrEqual(9);
    expect(countSteps(walk, 20)).toBeLessThanOrEqual(11);
    const still = Array.from({ length: 100 }, (_, i) => 9.81 + 0.3 * Math.sin(i));
    expect(countSteps(still, 20)).toBe(0);
  });
});
