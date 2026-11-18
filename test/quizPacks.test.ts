import { describe, expect, it } from "vitest";

import { QUIZ_PACKS, filterQuizPacks } from "@/lib/quizPacks";
import { QUIZ, normQuiz } from "@/lib/rules/quiz";

// Reglene (1–30 spørsmål, 3–200 tegn, 2–4 svar à 1–80 tegn, unike svar, c i området)
// kommer fra chase._quiz_norm()/kq() i supabase/migrations/0012_quiz_steps.sql,
// via TS-tvillingen normQuiz og QUIZ i lib/rules/quiz.ts.
describe("ferdige quizpakker", () => {
  it("har 10 pakker med unike id-er", () => {
    expect(QUIZ_PACKS).toHaveLength(10);
    expect(new Set(QUIZ_PACKS.map((p) => p.id)).size).toBe(10);
  });

  for (const p of QUIZ_PACKS) {
    describe(p.title, () => {
      it("har 8–12 spørsmål og gyldige trinn", () => {
        expect(p.items.length).toBeGreaterThanOrEqual(8);
        expect(p.items.length).toBeLessThanOrEqual(12);
        expect(p.items.length).toBeLessThanOrEqual(QUIZ.quiz_max);
        expect(p.grades[0]).toBeGreaterThanOrEqual(5);
        expect(p.grades[1]).toBeLessThanOrEqual(10);
        expect(p.grades[0]).toBeLessThanOrEqual(p.grades[1]);
        expect(p.lk20.length).toBeGreaterThan(10);
      });
      it("består samme validering som serveren, uten at noe endres", () => {
        expect(normQuiz(p.items)).toEqual(p.items);
      });
      it("har unike spørsmål", () => {
        expect(new Set(p.items.map((x) => x.q)).size).toBe(p.items.length);
      });
    });
  }

  it("filtrerer på trinn og fag", () => {
    expect(filterQuizPacks(null, null)).toHaveLength(10);
    expect(filterQuizPacks(9, null).map((p) => p.id)).toContain("demokrati-stortinget");
    expect(filterQuizPacks(5, "Matematikk").map((p) => p.id)).toEqual(["gangetabellen"]);
  });
});
