// TS twin of chase.kq() and the pure quiz/step rules in
// supabase/migrations/0012_quiz_steps.sql (CLAUDE.md rule 2), plus the
// teacher's text format for writing questions. test/quiz.test.ts diffs QUIZ
// against the SQL and runs the same vectors as test/sql/0012_quiz_steps.test.sql.

export const QUIZ = {
  quiz_max: 30,
  q_min: 3,
  q_max: 200,
  answers_min: 2,
  answers_max: 4,
  answer_max: 80,
  quiz_s: 60,
  quiz_pts: 10,
  steps_max_per_s: 4,
  steps_gap_s: 2,
} as const;

export interface QuizItem {
  q: string;
  a: string[];
  /** Index of the right answer (server-side only during a game). */
  c: number;
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const len = (s: string) => [...s].length;

/** Same as chase._quiz_norm(). null = invalid. */
export function normQuiz(p: unknown): QuizItem[] | null {
  if (!Array.isArray(p) || p.length < 1 || p.length > QUIZ.quiz_max) return null;
  const out: QuizItem[] = [];
  for (const x of p as Array<Record<string, unknown>>) {
    if (!x || typeof x !== "object" || typeof x.q !== "string" || !Array.isArray(x.a) || typeof x.c !== "number") return null;
    const q = squash(x.q);
    if (len(q) < QUIZ.q_min || len(q) > QUIZ.q_max || x.a.length < QUIZ.answers_min || x.a.length > QUIZ.answers_max) return null;
    const a: string[] = [];
    for (const y of x.a) {
      if (typeof y !== "string") return null;
      const t = squash(y);
      if (len(t) < 1 || len(t) > QUIZ.answer_max || a.some((z) => z.toLowerCase() === t.toLowerCase())) return null;
      a.push(t);
    }
    if (!Number.isInteger(x.c) || x.c < 0 || x.c >= a.length) return null;
    out.push({ q, a, c: x.c });
  }
  return out;
}

/** Same as chase._quiz_pick(). */
export function quizPick(asked: number, n: number, offset: number): number | null {
  if (n <= 0) return null;
  return (((offset % n) + n) % n + asked) % n;
}

/** Same as chase._steps_accept(): new steps accepted from one report. */
export function stepsAccept(steps: number | null, gapS: number | null): number {
  const gap = Math.max(0, gapS ?? QUIZ.steps_gap_s);
  return Math.max(0, Math.min(steps ?? 0, Math.ceil(gap * QUIZ.steps_max_per_s)));
}

/**
 * Teacher's text format: one question per block (blank line between), the
 * question on the first line, then 2–4 answers, the right one starting with «*».
 *   Hovedstaden i Norge?
 *   Bergen
 *   *Oslo
 */
export function parseQuizText(text: string): { items: QuizItem[]; errors: number[] } {
  const items: QuizItem[] = [];
  const errors: number[] = [];
  const blocks = text.split(/\n\s*\n/).map((b) => b.split("\n").map((l) => l.trim()).filter(Boolean)).filter((b) => b.length);
  blocks.forEach((b, i) => {
    const [q, ...rest] = b;
    const right = rest.findIndex((l) => l.startsWith("*"));
    const a = rest.map((l) => l.replace(/^\*\s*/, ""));
    const one = normQuiz([{ q, a, c: right }]);
    if (one && rest.filter((l) => l.startsWith("*")).length === 1) items.push(one[0]);
    else errors.push(i + 1);
  });
  return { items, errors };
}

export function quizToText(items: QuizItem[]): string {
  return items.map((x) => [x.q, ...x.a.map((a, i) => (i === x.c ? `*${a}` : a))].join("\n")).join("\n\n");
}
