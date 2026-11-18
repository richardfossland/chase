"use client";

// Writing a question pack in the teacher's text format (lib/rules/quiz.ts):
// one question per paragraph, 2–4 answers, the right one marked «*».

import { useEffect, useRef, useState } from "react";

import { no } from "@/lib/locale/no";
import { QUIZ_PACK_SUBJECTS, filterQuizPacks } from "@/lib/quizPacks";
import { parseQuizText, quizToText, type QuizItem } from "@/lib/rules/quiz";

const q = no.quiz;

export function QuizEditor(props: {
  items: QuizItem[] | undefined;
  onChange: (items: QuizItem[] | undefined, valid: boolean) => void;
  packs?: { id: string; name: string; items: QuizItem[] }[];
  onSavePack?: (name: string, items: QuizItem[]) => Promise<boolean>;
  compact?: boolean;
  /** Vis «Velg ferdig pakke» (lib/quizPacks.ts). */
  ready?: boolean;
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
  const [readyOpen, setReadyOpen] = useState(false);
  const [grade, setGrade] = useState<number | null>(null);
  const [subject, setSubject] = useState<string | null>(null);
  const shown = filterQuizPacks(grade, subject);
  const applyPack = (items: QuizItem[]) => {
    if (text.trim() && !window.confirm(q.ready.replace)) return;
    set(quizToText(items));
    setReadyOpen(false);
  };
  const btn = "ui-press min-h-12 rounded-[var(--radius-ctl)] border border-line bg-ink-2 px-3 text-sm font-bold hover:bg-ink-3 disabled:opacity-40";
  const field =
    "w-full min-h-12 rounded-[var(--radius-ctl)] border border-line bg-ink px-4 py-2.5 outline-none transition-[border-color,box-shadow] duration-[var(--dur-1)] focus:border-gold-deep focus:ring-4 focus:ring-gold/20";
  return (
    <div data-testid="quiz-editor">
      {!props.compact && (
        <>
          <p className="text-sm font-semibold">{q.editor}</p>
          <p className="text-xs text-txt-dim">{q.editorLead}</p>
        </>
      )}
      {props.ready && (
        <div className="mt-2" data-testid="quiz-ready">
          <button type="button" className={btn} aria-expanded={readyOpen} onClick={() => setReadyOpen((o) => !o)}>
            {q.ready.open}
          </button>
          {readyOpen && (
            <div className="mt-2 rounded-[var(--radius-ctl)] border border-line p-3">
              <p className="text-xs text-txt-dim">{q.ready.lead}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <label className="text-xs font-bold">
                  {q.ready.grade}
                  <select
                    className={`${field} mt-1 text-sm`}
                    value={grade ?? ""}
                    onChange={(e) => setGrade(e.target.value ? Number(e.target.value) : null)}
                  >
                    <option value="">{q.ready.all}</option>
                    {[5, 6, 7, 8, 9, 10].map((g) => (
                      <option key={g} value={g}>
                        {q.ready.gradeN(g)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-xs font-bold">
                  {q.ready.subject}
                  <select className={`${field} mt-1 text-sm`} value={subject ?? ""} onChange={(e) => setSubject(e.target.value || null)}>
                    <option value="">{q.ready.all}</option>
                    {QUIZ_PACK_SUBJECTS.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {shown.length === 0 && <p className="mt-2 text-sm text-txt-dim">{q.ready.none}</p>}
              <ul className="mt-2 grid gap-2">
                {shown.map((p) => (
                  <li key={p.id} className="flex items-center gap-2 rounded-[var(--radius-ctl)] bg-ink-2 p-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-bold">{p.title}</p>
                      <p className="text-xs text-txt-dim">
                        {p.subject} · {q.ready.grades(p.grades[0], p.grades[1])} · {q.ready.questions(p.items.length)}
                      </p>
                      <p className="text-xs text-txt-dim">{p.lk20}</p>
                    </div>
                    <button type="button" className={btn} onClick={() => applyPack(p.items)}>
                      {q.ready.use}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      <textarea
        className={`${field} mt-2 min-h-32 font-mono text-sm leading-relaxed`}
        placeholder={q.placeholder}
        value={text}
        onChange={(e) => set(e.target.value)}
      />
      <p className={`mt-1 min-h-4 text-xs font-bold ${parsed.errors.length ? "text-warn-text" : "text-txt-dim"}`} aria-live="polite">
        {parsed.errors.length ? q.errorsAt(parsed.errors) : parsed.items.length ? q.count(parsed.items.length) : ""}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
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
          className="mt-2 flex flex-wrap gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (naming.trim() && (await props.onSavePack!(naming, parsed.items))) {
              setSaved(true);
              setNaming(null);
            }
          }}
        >
          <input
            className={`${field} min-w-40 flex-1 text-sm font-bold`}
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
