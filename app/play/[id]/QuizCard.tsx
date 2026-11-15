"use client";

// Phone side of phase 7 (0012): the question after a post. The server never
// sends the right answer before the player has answered.

import { useState } from "react";

import type { TickView } from "@/lib/client/api";
import { cx } from "@/lib/client/ui";
import { IconClock, IconHelp } from "@/lib/client/ui/icons";
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
  // The tapped answer lights up at once; the result flash (riktig/feil) comes from the server's reply.
  const [picked, setPicked] = useState<number | null>(null);
  return (
    <div className="m-sheet-in absolute inset-x-3 bottom-28 z-30 rounded-3xl border-2 border-gold bg-ink-2 p-5 text-txt shadow-[var(--shadow-float)]" role="dialog" data-testid="quiz-card">
      <div className="flex items-center justify-between font-black text-gold-text">
        <span className="flex items-center gap-2 text-sm uppercase tracking-wider">
          <IconHelp size={20} />
          {q.title}
        </span>
        <span className={cx("flex items-center gap-1.5 text-2xl tabular-nums", left <= 5 && left > 0 && "text-danger-text")}>
          <IconClock size={20} />
          {q.left(left)}
        </span>
      </div>
      <p className="mt-3 text-2xl font-black leading-tight">{quiz.q}</p>
      <div className="m-stagger mt-4 grid gap-2.5">
        {quiz.a.map((a, i) => (
          <button
            key={a}
            disabled={busy || picked !== null || left === 0}
            style={{ "--i": i } as React.CSSProperties}
            className={cx(
              "ui-press min-h-16 rounded-2xl border-2 px-5 py-3.5 text-left text-lg font-black transition-[background-color,border-color,opacity,transform]",
              picked === i ? "border-gold bg-gold text-on-accent" : "border-transparent bg-ink-3",
              picked !== null && picked !== i && "opacity-40",
              picked === null && "disabled:opacity-50",
            )}
            onClick={() => {
              setPicked(i);
              onAnswer(i);
            }}
            data-testid={`quiz-${i}`}
          >
            {a}
          </button>
        ))}
      </div>
    </div>
  );
}
