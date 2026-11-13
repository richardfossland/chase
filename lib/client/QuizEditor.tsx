"use client";

// Writing a question pack in the teacher's text format (lib/rules/quiz.ts):
// one question per paragraph, 2–4 answers, the right one marked «*».

import { useEffect, useRef, useState } from "react";

import { no } from "@/lib/locale/no";
import { parseQuizText, quizToText, type QuizItem } from "@/lib/rules/quiz";

const q = no.quiz;

export function QuizEditor(props: {
  items: QuizItem[] | undefined;
  onChange: (items: QuizItem[] | undefined, valid: boolean) => void;
  packs?: { id: string; name: string; items: QuizItem[] }[];
  onSavePack?: (name: string, items: QuizItem[]) => Promise<boolean>;
  compact?: boolean;
}) {
  const [text, setText] = useState(props.items?.length ? quizToText(props.items) : "");
  const [naming, setNaming] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // A plan loaded from outside (library, share) replaces the text.
  const ext = props.items?.length ? quizToText(props.items) : "";
  const last = useRef(ext);
  useEffect(() => {
    if (ext !== last.current && ext !== quizToText(parseQuizText(text).items)) {
       
      setText(ext);
    }
    last.current = ext;
  }, [ext, text]);
  const parsed = parseQuizText(text);
  const set = (v: string) => {
    setText(v);
    setSaved(false);
    const p = parseQuizText(v);
    props.onChange(p.items.length ? p.items : undefined, p.errors.length === 0);
  };
  const btn = "rounded-lg border border-line px-2.5 py-1.5 text-xs font-bold transition hover:bg-ink-3 disabled:opacity-40";
  return (
    <div data-testid="quiz-editor">
      {!props.compact && (
        <>
          <p className="text-sm font-semibold">{q.editor}</p>
          <p className="text-xs text-txt-dim">{q.editorLead}</p>
        </>
      )}
      <textarea
        className="mt-2 min-h-28 w-full rounded-xl border border-line bg-ink px-3 py-2 font-mono text-sm outline-none focus:border-gold"
        placeholder={q.placeholder}
        value={text}
        onChange={(e) => set(e.target.value)}
      />
      <p className={`text-xs font-bold ${parsed.errors.length ? "text-warn" : "text-txt-dim"}`}>
        {parsed.errors.length ? q.errorsAt(parsed.errors) : parsed.items.length ? q.count(parsed.items.length) : ""}
      </p>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {props.packs?.map((p) => (
          <button key={p.id} className={btn} onClick={() => set(quizToText(p.items))}>
            {q.fromPack}: {p.name}
          </button>
        ))}
        {props.onSavePack && parsed.items.length > 0 && !parsed.errors.length && naming === null && (
          <button className={btn} onClick={() => setNaming("")}>
            {saved ? no.missions.saved : q.savePack}
          </button>
        )}
      </div>
      {naming !== null && props.onSavePack && (
        <form
          className="mt-2 flex gap-1.5"
          onSubmit={async (e) => {
            e.preventDefault();
            if (naming.trim() && (await props.onSavePack!(naming, parsed.items))) {
              setSaved(true);
              setNaming(null);
            }
          }}
        >
          <input
            className="flex-1 rounded-lg border border-line bg-ink px-2 py-1.5 text-sm font-bold outline-none focus:border-gold"
            placeholder={no.library.packName}
            value={naming}
            onChange={(e) => setNaming(e.target.value)}
            autoFocus
          />
          <button className={btn} disabled={!naming.trim()}>
            {no.library.save}
          </button>
          <button type="button" className={btn} onClick={() => setNaming(null)}>
            {no.common.cancel}
          </button>
        </form>
      )}
    </div>
  );
}
