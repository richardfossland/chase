"use client";

// The teacher's library (0010, PLAN §13 fase 6): lærernøkkel export/import,
// areas, plans («opplegg»), mission packs and share links. Everything is tied
// to the lærernøkkel in localStorage; the server only sees its hash.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { AreaThumb } from "@/lib/client/AreaThumb";
import { ApiError, api, type LibArea, type LibKind, type LibPlan, type Library } from "@/lib/client/api";
import { ConfirmDialog } from "@/lib/client/ConfirmDialog";
import { identity } from "@/lib/client/identity";
import { planSummary } from "@/lib/client/planSummary";
import { QRCode } from "@/lib/client/QRCode";
import { QrScanner } from "@/lib/client/QrScanner";
import { QuizEditor } from "@/lib/client/QuizEditor";
import { Chip, buttonClass, cx } from "@/lib/client/ui";
import type { QuizItem } from "@/lib/rules/quiz";
import { no } from "@/lib/locale/no";
import { LIBRARY, normMissions, parseTeacherKey, teacherKeyQr } from "@/lib/rules/library";

const t = no.library;
const btn = buttonClass("secondary", "md", "px-3.5 text-sm font-bold");
const gold = buttonClass("primary", "md");
const danger = buttonClass("ghost", "md", "px-3 text-sm font-bold text-danger-text hover:bg-danger/10");
const quiet = buttonClass("ghost", "md", "px-3 text-sm font-bold text-txt-dim hover:text-txt");
const input =
  "w-full min-h-12 rounded-[var(--radius-ctl)] border border-line bg-ink px-4 py-2.5 font-bold outline-none transition-[border-color,box-shadow] duration-[var(--dur-1)] focus:border-gold-deep focus:ring-4 focus:ring-gold/20";
const card = "rounded-[var(--radius-card)] bg-ink-2 p-4 shadow-[var(--shadow-card)]";

type Confirm = { message: string; danger?: boolean; run: () => void } | null;

function errText(e: unknown) {
  const c = e instanceof ApiError ? e.code : "default";
  return t.errors[c] ?? t.errors.default;
}

export default function LibraryView() {
  const [key, setKey] = useState<string | null>(null);
  const [libr, setLibr] = useState<Library | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [sharing, setSharing] = useState<LibPlan | null>(null);

  const load = useCallback(async (k: string) => {
    try {
      setLibr(await api.library.get(k));
      setErr(null);
    } catch (e) {
      setErr(errText(e));
    }
  }, []);

  useEffect(() => {
    const { key: k } = identity.ensureTeacherKey();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage after mount
    setKey(k);
    void load(k);
  }, [load]);

  const act = useCallback(
    async (f: () => Promise<unknown>) => {
      if (!key) return false;
      try {
        await f();
        await load(key);
        return true;
      } catch (e) {
        setErr(errText(e));
        return false;
      }
    },
    [key, load],
  );

  const rename = (kind: LibKind, id: string, name: string, data: unknown = null) =>
    act(() => api.library.save(key!, kind, name, data, id));
  const remove = (kind: LibKind, id: string, name: string) =>
    setConfirm({ message: t.removeConfirm(name), danger: true, run: () => void act(() => api.library.remove(key!, kind, id)) });

  const total = libr ? libr.areas.length + libr.plans.length + libr.packs.length : 0;

  return (
    <main className="mx-auto max-w-2xl px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-24 sm:px-6">
      <div className="flex min-h-12 items-center justify-between gap-3">
        <Link href="/" className={cx(quiet, "-ml-3")}>
          {t.back}
        </Link>
        <Link href="/ny" className={gold}>
          {t.newSession}
        </Link>
      </div>
      <div className="m-rise-in">
        <h1 className="mt-8 text-4xl font-black tracking-tight sm:text-5xl">{t.title}</h1>
        <p className="mt-3 max-w-prose leading-relaxed text-txt-dim">{t.lead}</p>
      </div>
      {err && (
        <p className="m-rise-in mt-5 rounded-2xl bg-warn/15 px-4 py-3 font-bold text-warn-text" role="alert">
          {err}
        </p>
      )}

      {key && <KeyPanel teacherKey={key} libraryCount={total} onSwitch={(k) => { setKey(k); void load(k); }} />}

      {!libr && !err && (
        <div className="mt-10 space-y-3" aria-busy="true">
          <p className="sr-only">{t.loading}</p>
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-20 animate-pulse rounded-[var(--radius-card)] bg-ink-3/70" />
          ))}
        </div>
      )}
      {libr && total === 0 && libr.shares.length === 0 && (
        <div className="m-rise-in mt-10 flex flex-col items-center rounded-[var(--radius-card)] border-2 border-dashed border-line px-6 py-10 text-center">
          <EmptyMap />
          <p className="mt-4 max-w-sm font-bold">{t.empty}</p>
          <Link href="/ny" className={cx(gold, "mt-5")}>
            {t.newSession}
          </Link>
        </div>
      )}

      {libr && libr.areas.length > 0 && (
        <Section title={t.areas}>
          {libr.areas.map((a) => (
            <AreaRow key={a.id} a={a} onRename={(n) => rename("area", a.id, n)} onRemove={() => remove("area", a.id, a.name)} />
          ))}
        </Section>
      )}

      {libr && libr.plans.length > 0 && (
        <Section title={t.plans}>
          {libr.plans.map((p) => (
            <PlanRow
              key={p.id}
              p={p}
              onRename={(n) => rename("plan", p.id, n)}
              onRemove={() => remove("plan", p.id, p.name)}
              onShare={() => setSharing(p)}
            />
          ))}
        </Section>
      )}

      {libr && (
        <Section title={t.packs}>
          {libr.packs.map((p) => (
            <PackEditor
              key={p.id}
              name={p.name}
              items={p.items}
              onSave={(name, items) => rename("pack", p.id, name, { items })}
              onRemove={() => remove("pack", p.id, p.name)}
            />
          ))}
          <PackEditor isNew onSave={(name, items) => act(() => api.library.save(key!, "pack", name, { items }))} />
        </Section>
      )}

      {libr && (
        <Section title={no.quiz.packs}>
          {(libr.quizzes ?? []).map((p) => (
            <QuizPackRow
              key={p.id}
              name={p.name}
              items={p.items}
              onSave={(name, items) => rename("quiz", p.id, name, { items })}
              onRemove={() => remove("quiz", p.id, p.name)}
            />
          ))}
          <QuizPackRow isNew onSave={(name, items) => act(() => api.library.save(key!, "quiz", name, { items }))} />
        </Section>
      )}

      {libr && libr.shares.length > 0 && (
        <Section title={t.shares}>
          {libr.shares.map((h) => (
            <li key={h.code} className={cx(card, "flex flex-wrap items-center gap-2")}>
              <div className="min-w-0 flex-1">
                <p className="truncate font-extrabold">{h.name}</p>
                <p className="text-sm text-txt-dim">
                  /d/{h.code}
                  {h.has_area ? ` · ${t.withArea}` : ""} · {t.copies(h.copies)}
                </p>
              </div>
              <CopyLink code={h.code} />
              <button
                className={btn}
                onClick={() => setConfirm({ message: t.revokeConfirm, danger: true, run: () => void act(() => api.library.revoke(key!, h.code)) })}
              >
                {t.revoke}
              </button>
            </li>
          ))}
        </Section>
      )}

      {sharing && libr && key && (
        <ShareSheet
          plan={sharing}
          areas={libr.areas}
          onClose={() => setSharing(null)}
          onShare={async (areaId) => {
            const ok = await act(() => api.library.share(key, sharing.id, areaId));
            if (ok) setSharing(null);
          }}
        />
      )}

      {confirm && (
        <ConfirmDialog
          message={confirm.message}
          danger={confirm.danger}
          onConfirm={() => {
            confirm.run();
            setConfirm(null);
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-xl font-black">{title}</h2>
      <ul className="m-stagger mt-4 space-y-3">{children}</ul>
    </section>
  );
}

function KindTag({ kind }: { kind: "recent" | "saved" }) {
  return (
    <Chip tone={kind === "saved" ? "gold" : "neutral"} className="flex-none">
      {kind === "saved" ? t.saved : t.recent}
    </Chip>
  );
}

function NameEdit({ name, onSave, onCancel }: { name: string; onSave: (n: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(name);
  return (
    <form
      className="m-fade-in mt-1 flex w-full flex-wrap gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (v.trim()) onSave(v);
      }}
    >
      <input className={cx(input, "min-w-40 flex-1")} value={v} maxLength={LIBRARY.name_max} onChange={(e) => setV(e.target.value)} aria-label={t.namePrompt} autoFocus />
      <button className={gold}>{t.save}</button>
      <button type="button" className={btn} onClick={onCancel}>
        {no.common.cancel}
      </button>
    </form>
  );
}

function AreaRow({ a, onRename, onRemove }: { a: LibArea; onRename: (n: string) => Promise<boolean>; onRemove: () => void }) {
  const [editing, setEditing] = useState(false);
  return (
    <li className={cx(card, "flex flex-wrap items-center gap-x-4 gap-y-3")} data-testid="lib-area">
      <AreaThumb area={a} />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 font-extrabold">
          <span className="truncate">{a.name}</span> <KindTag kind={a.kind} />
        </p>
        <p className="text-sm text-txt-dim">{no.map.area(a.area_m2)}</p>
      </div>
      <div className="flex w-full flex-wrap gap-2 sm:w-auto">
        <Link href={`/ny?area=${a.id}`} className={btn}>
          {t.use}
        </Link>
        <button className={btn} onClick={() => setEditing(true)}>
          {a.kind === "recent" ? t.keep : t.rename}
        </button>
        <button className={danger} onClick={onRemove}>
          {t.remove}
        </button>
      </div>
      {editing && (
        <NameEdit
          name={a.kind === "recent" ? "" : a.name}
          onSave={async (n) => {
            if (await onRename(n)) setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      )}
    </li>
  );
}

function PlanRow({ p, onRename, onRemove, onShare }: { p: LibPlan; onRename: (n: string) => Promise<boolean>; onRemove: () => void; onShare: () => void }) {
  const [editing, setEditing] = useState(false);
  const s = planSummary(p.plan);
  return (
    <li className={cx(card, "flex flex-wrap items-center gap-x-4 gap-y-3")} data-testid="lib-plan">
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 font-extrabold">
          <span className="truncate">{p.name}</span> <KindTag kind={p.kind} />
        </p>
        <p className="text-sm text-txt-dim">
          {s.modes} · {t.minutes(s.minutes)}
          {p.plan.missions?.length ? ` · ${t.missionsN(p.plan.missions.length)}` : ""}
        </p>
      </div>
      <div className="flex w-full flex-wrap gap-2 sm:w-auto">
        <Link href={`/ny?plan=${p.id}`} className={btn}>
          {t.use}
        </Link>
        <button className={btn} onClick={onShare}>
          🔗 {t.share}
        </button>
        <button className={btn} onClick={() => setEditing(true)}>
          {p.kind === "recent" ? t.keep : t.rename}
        </button>
        <button className={danger} onClick={onRemove}>
          {t.remove}
        </button>
      </div>
      {editing && (
        <NameEdit
          name={p.kind === "recent" ? "" : p.name}
          onSave={async (n) => {
            if (await onRename(n)) setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      )}
    </li>
  );
}

function PackEditor(props: { isNew?: boolean; name?: string; items?: string[]; onSave: (name: string, items: string[]) => Promise<boolean>; onRemove?: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(props.name ?? "");
  const [text, setText] = useState((props.items ?? []).join("\n"));
  const items = normMissions(text.split("\n").filter((l) => l.trim()));
  if (!open) {
    return props.isNew ? (
      <li>
        <button className={buttonClass("ghost", "md", "w-full rounded-[var(--radius-card)] border-2 border-dashed border-line text-sm font-bold text-txt-dim hover:border-gold/60 hover:text-txt")} onClick={() => setOpen(true)}>
          {t.newPack}
        </button>
      </li>
    ) : (
      <li className={cx(card, "flex flex-wrap items-center gap-3")}>
        <div className="min-w-0 flex-1">
          <p className="truncate font-extrabold">{props.name}</p>
          <p className="truncate text-sm text-txt-dim">{props.items?.join(" · ")}</p>
        </div>
        <button className={btn} onClick={() => setOpen(true)}>
          {t.rename}
        </button>
        <button className={danger} onClick={props.onRemove}>
          {t.remove}
        </button>
      </li>
    );
  }
  return (
    <li className={cx(card, "m-scale-in space-y-3 ring-2 ring-gold/40")}>
      <input className={input} placeholder={t.packName} value={name} maxLength={LIBRARY.name_max} onChange={(e) => setName(e.target.value)} />
      <textarea className={`${input} min-h-32`} placeholder={t.packItems} value={text} onChange={(e) => setText(e.target.value)} />
      {!items && text.trim() && <p className="text-sm font-bold text-warn-text">{t.errors.bad_pack}</p>}
      <div className="flex gap-2">
        <button
          className={gold}
          disabled={!items || !name.trim()}
          onClick={async () => {
            if (items && (await props.onSave(name, items))) {
              setOpen(false);
              if (props.isNew) {
                setName("");
                setText("");
              }
            }
          }}
        >
          {t.save}
        </button>
        <button className={quiet} onClick={() => setOpen(false)}>
          {no.common.cancel}
        </button>
      </div>
    </li>
  );
}

function CopyLink({ code }: { code: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={btn}
      onClick={() => {
        void navigator.clipboard?.writeText(`${window.location.origin}/d/${code}`).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 2000);
        });
      }}
    >
      {done ? t.copied : t.copyLink}
    </button>
  );
}

function ShareSheet({ plan, areas, onClose, onShare }: { plan: LibPlan; areas: LibArea[]; onClose: () => void; onShare: (areaId: string | null) => void }) {
  const [area, setArea] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chip = (on: boolean) =>
    cx(
      "ui-press min-h-12 w-full rounded-[var(--radius-ctl)] px-3 py-1.5 text-left font-bold",
      on ? "bg-gold text-on-accent shadow-[var(--shadow-card)]" : "border border-line bg-ink-2 hover:bg-ink-3",
    );
  return (
    <div className="m-fade-in fixed inset-0 z-50 flex items-end justify-center bg-black/35 p-3 sm:items-center" onClick={onClose}>
      <div
        className="m-sheet-in max-h-[85dvh] w-full max-w-md overflow-y-auto rounded-[1.75rem] bg-ink-2 p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-[var(--shadow-float)]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <h2 className="text-xl font-black">{t.shareTitle(plan.name)}</h2>
        <p className="mt-1 text-sm text-txt-dim">{t.shareLead}</p>
        <p className="mt-5 text-sm font-bold">{t.shareArea}</p>
        <div className="mt-2 space-y-2">
          <button className={chip(area === null)} onClick={() => setArea(null)}>
            {t.shareAreaNone}
          </button>
          {areas.map((a) => (
            <button key={a.id} className={`${chip(area === a.id)} flex items-center gap-3`} onClick={() => setArea(a.id)}>
              <AreaThumb area={a} size={36} />
              {a.name}
            </button>
          ))}
        </div>
        {area && <p className="mt-2 text-xs text-txt-dim">{t.shareAreaHint}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button className={quiet} onClick={onClose}>
            {no.common.cancel}
          </button>
          <button
            className={gold}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await onShare(area);
              setBusy(false);
            }}
            data-testid="share-create"
          >
            {t.shareCreate}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Export (show key + QR) and import (type or scan) of the lærernøkkel. */
function KeyPanel({ teacherKey, libraryCount, onSwitch }: { teacherKey: string; libraryCount: number; onSwitch: (k: string) => void }) {
  const k = t.key;
  const [show, setShow] = useState(false);
  const [importing, setImporting] = useState(false);
  const [typed, setTyped] = useState("");
  const [scan, setScan] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  async function tryKey(raw: string) {
    const key = parseTeacherKey(raw);
    if (!key) return setMsg(k.bad);
    if (key === teacherKey) return setMsg(null);
    try {
      const l = await api.library.get(key);
      if (!l.known) return setMsg(k.unknown);
      if (libraryCount > 0) return setConfirm(key);
      apply(key, l.areas.length, l.plans.length);
    } catch (e) {
      setMsg(errText(e));
    }
  }
  function apply(key: string, a: number, p: number) {
    identity.setTeacherKey(key);
    onSwitch(key);
    setImporting(false);
    setTyped("");
    setMsg(k.done(a, p));
  }

  return (
    <section className={cx(card, "m-rise-in relative mt-8 overflow-hidden p-5")}>
      <span className="absolute inset-y-0 left-0 w-1.5 bg-gold" aria-hidden />
      <h2 className="font-black text-gold-text">{k.title}</h2>
      <p className="mt-1 max-w-prose text-sm leading-relaxed text-txt-dim">{k.lead}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button className={btn} onClick={() => setShow((s) => !s)} data-testid="key-show">
          {show ? k.hide : k.show}
        </button>
        <button className={btn} onClick={() => setImporting((s) => !s)}>
          {k.import}
        </button>
      </div>
      {show && (
        <div className="m-scale-in mt-4 flex flex-col items-center gap-3 rounded-2xl bg-ink p-4 text-center">
          <p className="font-mono text-xl font-black tracking-wider sm:text-2xl" data-testid="key-value">
            {teacherKey}
          </p>
          <QRCode value={teacherKeyQr(teacherKey)} size={180} />
          <p className="max-w-xs text-xs font-bold text-warn-text">{k.warn}</p>
        </div>
      )}
      {importing && (
        <form
          className="m-fade-in mt-4 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void tryKey(typed);
          }}
        >
          <p className="text-sm text-txt-dim">{k.importLead}</p>
          <div className="flex gap-2">
            <input className={`${input} font-mono uppercase`} placeholder={k.importField} value={typed} onChange={(e) => setTyped(e.target.value)} autoCapitalize="characters" autoComplete="off" />
            <button type="button" className={btn} onClick={() => setScan(true)}>
              {k.scan}
            </button>
          </div>
          <button className={gold} disabled={!typed.trim()}>
            {k.importBtn}
          </button>
        </form>
      )}
      {msg && <p className="m-fade-in mt-3 text-sm font-bold" role="status">{msg}</p>}
      {scan && (
        <QrScanner
          title={k.scanTitle}
          codeLabel={k.importField}
          busy={false}
          onClose={() => setScan(false)}
          onCode={(text) => {
            setScan(false);
            setTyped(text.replace(/^CHASE-KEY:/i, ""));
            void tryKey(text);
          }}
        />
      )}
      {confirm && (
        <ConfirmDialog
          message={k.replaceConfirm(libraryCount)}
          danger
          onConfirm={async () => {
            const key = confirm;
            setConfirm(null);
            const l = await api.library.get(key).catch(() => null);
            apply(key, l?.areas.length ?? 0, l?.plans.length ?? 0);
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </section>
  );
}

function QuizPackRow(props: { isNew?: boolean; name?: string; items?: QuizItem[]; onSave: (name: string, items: QuizItem[]) => Promise<boolean>; onRemove?: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(props.name ?? "");
  const [items, setItems] = useState<QuizItem[] | undefined>(props.items);
  const [valid, setValid] = useState(true);
  if (!open) {
    return props.isNew ? (
      <li>
        <button className={buttonClass("ghost", "md", "w-full rounded-[var(--radius-card)] border-2 border-dashed border-line text-sm font-bold text-txt-dim hover:border-gold/60 hover:text-txt")} onClick={() => setOpen(true)}>
          {no.quiz.newPack}
        </button>
      </li>
    ) : (
      <li className={cx(card, "flex flex-wrap items-center gap-3")}>
        <div className="min-w-0 flex-1">
          <p className="truncate font-extrabold">{props.name}</p>
          <p className="truncate text-sm text-txt-dim">{no.quiz.count(props.items?.length ?? 0)} · {props.items?.[0]?.q}</p>
        </div>
        <button className={btn} onClick={() => setOpen(true)}>
          {t.rename}
        </button>
        <button className={danger} onClick={props.onRemove}>
          {t.remove}
        </button>
      </li>
    );
  }
  return (
    <li className={cx(card, "m-scale-in space-y-3 ring-2 ring-gold/40")}>
      <input className={input} placeholder={t.packName} value={name} maxLength={LIBRARY.name_max} onChange={(e) => setName(e.target.value)} />
      <QuizEditor compact items={items} onChange={(it, ok) => { setItems(it); setValid(ok); }} />
      <div className="flex gap-2">
        <button
          className={gold}
          disabled={!items?.length || !valid || !name.trim()}
          onClick={async () => {
            if (items && (await props.onSave(name, items))) {
              setOpen(false);
              if (props.isNew) {
                setName("");
                setItems(undefined);
              }
            }
          }}
        >
          {t.save}
        </button>
        <button className={quiet} onClick={() => setOpen(false)}>
          {no.common.cancel}
        </button>
      </div>
    </li>
  );
}

/** Quiet illustration for the empty library: a folded map with a gold area. */
function EmptyMap() {
  return (
    <svg width="120" height="84" viewBox="0 0 120 84" aria-hidden>
      <path d="M8 14 L40 6 L80 14 L112 6 L112 70 L80 78 L40 70 L8 78 Z" fill="var(--color-ink-2)" stroke="var(--color-line)" strokeWidth="2" strokeLinejoin="round" />
      <path d="M40 6 L40 70 M80 14 L80 78" stroke="var(--color-line)" strokeWidth="2" />
      <path d="M30 30 L62 22 L88 38 L76 60 L40 58 Z" fill="#ebb84b" fillOpacity="0.18" stroke="#d4a23a" strokeWidth="2.5" strokeDasharray="5 4" strokeLinejoin="round" />
      <circle cx="56" cy="44" r="5" fill="#4fd18b" stroke="#fff" strokeWidth="2" />
    </svg>
  );
}
