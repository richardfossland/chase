"use client";

// Phone side of phase 7 (0012): the question after a post. The server never
// sends the right answer before the player has answered.

import type { TickView } from "@/lib/client/api";
import { no } from "@/lib/locale/no";

const q = no.quiz;

export function QuizCard({
  quiz,
  offsetMs,
  now,
  busy,
  onAnswer,
}: {
  quiz: NonNullable<TickView["quiz"]>;
  offsetMs: number;
  now: number;
  busy: boolean;
  onAnswer: (i: number) => void;
}) {
  const left = Math.max(0, Math.ceil((Date.parse(quiz.until) - (now + offsetMs)) / 1000));
  return (
    <div className="absolute inset-x-3 bottom-28 z-30 rounded-3xl border-2 border-gold bg-ink-2 p-4 text-txt shadow-2xl" role="dialog" data-testid="quiz-card">
      <div className="flex items-center justify-between text-sm font-black text-gold">
        <span>{q.title}</span>
        <span className="tabular-nums">{q.left(left)}</span>
      </div>
      <p className="mt-2 text-2xl font-black leading-tight">{quiz.q}</p>
      <p className="mt-1 text-xs text-txt-dim">{q.lead}</p>
      <div className="mt-3 grid gap-2">
        {quiz.a.map((a, i) => (
          <button
            key={a}
            disabled={busy || left === 0}
            className="rounded-2xl bg-ink-3 px-4 py-3.5 text-left text-lg font-black transition active:scale-[0.98] disabled:opacity-50"
            onClick={() => onAnswer(i)}
            data-testid={`quiz-${i}`}
          >
            {a}
          </button>
        ))}
      </div>
    </div>
  );
}
