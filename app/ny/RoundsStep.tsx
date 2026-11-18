"use client";

// Step 2 «Runder»: pick a ready-made opplegg, optionally tailor the rounds,
// and (folded away) the extras: breather, teams, QR-kort, Overraskelser,
// Egne øvelser and Quiz. Plan rules live in lib/rules/game.ts (normPlan).

import { useEffect, useRef, useState } from "react";

import { QuizEditor } from "@/lib/client/QuizEditor";
import { Button, Chip, cx } from "@/lib/client/ui";
import {
  IconArrowUp,
  IconChevronDown,
  IconClock,
  IconCrown,
  IconFlag,
  IconMapPin,
  IconMove,
  IconPlus,
  IconRepeat,
  IconShrink,
  IconTrash,
  IconUsers,
} from "@/lib/client/ui/icons";
import { planSummary } from "@/lib/client/planSummary";
import { no } from "@/lib/locale/no";
import { normMissions } from "@/lib/rules/library";
import { DEFAULT_PLAN, GAME, TEMPLATES, hasPractice, normPlan, planTotalS, withPractice, withoutPractice, type Plan, type RoundMode, type TemplateId } from "@/lib/rules/game";
import type { QuizItem } from "@/lib/rules/quiz";
import { TEAMS, isTeamRound } from "@/lib/rules/teams";
import { STARTER_PACKS, type StarterPack } from "@/lib/starter";

import { IconFox, IconMinus, IconRelay, IconSpread } from "./icons";
import { Disclosure, Help, Label, Note, SheetFooter, Switch, card, choice, field, iconBtn } from "./parts";

const t = no.wizard;
const p = t.playlist;

const ROUND_MINUTES = [3, 4, 5, 6, 8, 10, 15];
const ROUND_KINDS = ["posts", "convert", "swap", "fox", "free", "flag", "king", "relay", "scoreo"] as const;
type Kind = (typeof ROUND_KINDS)[number];
const TEAM_COUNTS = [2, 3, 4] as const;
const BREATHERS = [0, 30, 60, 90, 120];
const EVENT_EVERY = [0, 60, 90, 120] as const;
const QR_COUNTS = [0, 4, 6, 8, 12];

const KIND_ICON: Record<Kind, (props: { size?: number; className?: string }) => React.ReactNode> = {
  posts: IconMapPin,
  convert: IconSpread,
  swap: IconRepeat,
  fox: IconFox,
  free: IconMove,
  flag: IconFlag,
  king: IconCrown,
  relay: IconRelay,
  scoreo: IconMapPin,
};

type Round = Plan["rounds"][number];
const kindOf = (r: Round): Kind => (r.mode === "tag" ? (r.variant ?? "convert") : (r.mode as Kind));

type Preset = { id: string; testId: string; name: string; plan: Plan; starter?: StarterPack };
const PRESETS: Preset[] = [
  { id: "standard", testId: "template-standard", name: p.standard, plan: DEFAULT_PLAN },
  ...(Object.keys(TEMPLATES) as TemplateId[]).map((id) => ({ id, testId: `template-${id}`, name: p.template[id], plan: TEMPLATES[id] as Plan })),
  ...STARTER_PACKS.map((pk) => ({ id: pk.id, testId: `starter-${pk.id}`, name: pk.name, plan: pk.plan, starter: pk })),
];
/** What makes two plans «the same opplegg» for highlighting a card. */
const presetKey = (pl: Plan) => JSON.stringify({ r: pl.rounds.filter((r) => !r.practice), t: pl.teams ?? null, m: pl.missions ?? null, b: pl.breather_s });

export function RoundsStep(props: {
  plan: Plan;
  onChange: (p: Plan) => void;
  voice: boolean;
  onVoice: (on: boolean) => void;
  onStarter: (pack: StarterPack) => void;
  quizValid: boolean;
  onQuizValid: (v: boolean) => void;
  missionPacks: { id: string; name: string; items: string[] }[];
  quizPacks: { id: string; name: string; items: QuizItem[] }[];
  onSave: (kind: "pack" | "quiz", name: string, items: unknown) => Promise<boolean>;
  onBack: () => void;
  onNext: () => void;
}) {
  const { plan, onChange } = props;
  const [openRounds, setOpenRounds] = useState(false);
  const [openRound, setOpenRound] = useState<number | null>(null);
  const [openMore, setOpenMore] = useState(false);
  const [openMissions, setOpenMissions] = useState(false);
  const [openQuiz, setOpenQuiz] = useState(false);

  const key = presetKey(plan);
  const selected = PRESETS.find((pr) => presetKey(pr.plan) === key)?.id ?? null;
  const missionCount = plan.missions?.length ?? 0;
  const missionsBad = missionCount > 0 && normMissions(plan.missions) === null;
  const quizCount = plan.quiz?.length ?? 0;
  const hasPosts = plan.rounds.some((r) => r.mode === "posts");
  const hasTeams = plan.rounds.some((r) => isTeamRound(r));
  const moreBad = missionsBad || !props.quizValid;

  function pick(pr: Preset) {
    let next: Plan = structuredClone(pr.plan);
    if (plan.quiz?.length) next.quiz = plan.quiz;
    if (hasPractice(plan)) next = withPractice(next);   // 0020: the choice of a prøverunde follows the teacher to the next opplegg
    onChange(next);
    if (pr.starter) props.onStarter(pr.starter);
    setOpenRound(null);
  }
  const setRound = (i: number, patch: Partial<Round>) =>
    onChange({ ...plan, rounds: plan.rounds.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const setKind = (i: number, k: Kind) =>
    setRound(
      i,
      k === "convert" || k === "swap" || k === "fox"
        ? { mode: "tag", variant: k, team: undefined }
        : k === "flag" || k === "king" || k === "relay" || k === "scoreo"
          ? { mode: k, variant: undefined, zone: undefined, team: undefined, practice: undefined }
          : { mode: k as RoundMode, variant: undefined, ...(k === "posts" ? {} : { practice: undefined }) },
    );
  const step = (i: number, dir: 1 | -1) => {
    const d = plan.rounds[i].duration_s;
    const list = ROUND_MINUTES.map((m) => m * 60);
    const n = dir > 0 ? list.find((s) => s > d) : [...list].reverse().find((s) => s < d);
    if (n) setRound(i, { duration_s: n });
  };
  const move = (i: number) => {
    const rounds = [...plan.rounds];
    [rounds[i - 1], rounds[i]] = [rounds[i], rounds[i - 1]];
    onChange({ ...plan, rounds });
    setOpenRound(i - 1);
  };

  return (
    <>
      <h2 className="text-xl font-black">{p.presets}</h2>
      <div className="m-stagger mt-5 grid grid-cols-2 gap-3">
        {PRESETS.map((pr, i) => {
          const sum = planSummary(pr.plan);
          const on = selected === pr.id;
          return (
            <button
              key={pr.id}
              className={card(on)}
              aria-pressed={on}
              onClick={() => pick(pr)}
              data-testid={pr.testId}
              style={{ "--i": i } as React.CSSProperties}
            >
              <span className="font-extrabold leading-tight">{pr.name}</span>
              <span className="mt-1.5 line-clamp-2 text-xs leading-snug text-txt-dim">{sum.modes}</span>
              <span className="mt-auto inline-flex items-center gap-1 pt-2 text-xs font-bold text-gold-text tabular-nums">
                <IconClock size={14} />
                {p.minutesTotal(sum.minutes)}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-5 rounded-2xl border border-line bg-ink px-3 py-1">
        <Switch
          label={p.practice}
          icon={<IconClock size={18} />}
          on={hasPractice(plan)}
          onChange={(on) => onChange(on ? withPractice(plan) : withoutPractice(plan))}
          testId="practice"
        />
        <Help>{p.practiceHint}</Help>
      </div>

      <Disclosure
        title={p.customize}
        open={openRounds}
        onToggle={() => setOpenRounds((o) => !o)}
        testId="customize"
        badge={selected ? null : <Chip tone="gold">{p.custom}</Chip>}
      >
        <ol className="space-y-2">
          {plan.rounds.map((r, i) => {
            const k = kindOf(r);
            const KindIcon = KIND_ICON[k];
            const open = openRound === i;
            return (
              <li key={i} className={cx("rounded-2xl border bg-ink", open ? "border-gold/50" : "border-line")}>
                <button
                  type="button"
                  className="ui-press flex min-h-14 w-full items-center gap-3 rounded-2xl px-3 text-left"
                  aria-expanded={open}
                  onClick={() => setOpenRound(open ? null : i)}
                  data-testid={`round-${i}`}
                >
                  <span className="grid size-8 flex-none place-items-center rounded-full bg-ink-2 text-sm font-black shadow-[var(--shadow-card)]">
                    {i + 1}
                  </span>
                  <KindIcon size={20} className="flex-none text-gold-text" />
                  <span className="min-w-0 flex-1 truncate font-extrabold">
                    {p.modes[k]}
                    {r.practice && <span className="ml-1.5 text-xs font-bold text-gold-text">{p.practiceTag}</span>}
                    {(r.zone || r.team) && (
                      <span className="ml-1.5 text-xs font-bold text-txt-dim">
                        {r.team ? p.team : ""} {r.zone ? p.zone : ""}
                      </span>
                    )}
                  </span>
                  <span className="flex-none text-sm font-bold text-txt-dim tabular-nums">{p.minutes(Math.round(r.duration_s / 60))}</span>
                  <IconChevronDown className="t-chevron flex-none text-txt-dim" />
                </button>
                {open && (
                  <div className="m-fade-in border-t border-line p-3">
                    <div className="grid grid-cols-2 gap-2">
                      {ROUND_KINDS.map((kk) => {
                        const Icon = KIND_ICON[kk];
                        const on = k === kk;
                        return (
                          <button
                            key={kk}
                            className={cx(
                              "ui-press flex min-h-12 flex-col items-start rounded-[var(--radius-ctl)] border px-3 py-2 text-left",
                              on ? "border-gold bg-gold/10" : "border-line bg-ink-2 hover:bg-ink-3",
                            )}
                            aria-pressed={on}
                            onClick={() => setKind(i, kk)}
                          >
                            <span className="flex items-center gap-2 text-sm font-extrabold">
                              <Icon size={18} className={on ? "text-gold-text" : "text-txt-dim"} />
                              {p.modes[kk]}
                            </span>
                            <span className="mt-0.5 text-xs leading-snug text-txt-dim">{p.modeHint[kk]}</span>
                          </button>
                        );
                      })}
                    </div>

                    <div className="mt-4 flex items-center gap-2">
                      <button className={iconBtn} onClick={() => step(i, -1)} disabled={r.duration_s <= ROUND_MINUTES[0] * 60} aria-label={p.less}>
                        <IconMinus />
                      </button>
                      <span className="min-w-20 flex-1 text-center text-lg font-black tabular-nums">
                        {p.minutes(Math.round(r.duration_s / 60))}
                      </span>
                      <button
                        className={iconBtn}
                        onClick={() => step(i, 1)}
                        disabled={r.duration_s >= ROUND_MINUTES[ROUND_MINUTES.length - 1] * 60}
                        aria-label={p.more}
                      >
                        <IconPlus />
                      </button>
                    </div>

                    {r.mode !== "flag" && r.mode !== "king" && r.mode !== "relay" && r.mode !== "scoreo" && !r.practice && (
                      <div className="mt-3 border-t border-line pt-2">
                        <Switch
                          label={p.zoneToggle}
                          icon={<IconShrink size={18} />}
                          on={!!r.zone}
                          onChange={(on) => setRound(i, { zone: on ? true : undefined })}
                          testId={`zone-${i}`}
                        />
                        {r.zone && <Help>{p.zoneHint}</Help>}
                        {(r.mode === "posts" || r.mode === "free") && (
                          <Switch
                            label={p.teamToggle}
                            icon={<IconUsers size={18} />}
                            on={!!r.team}
                            onChange={(on) => setRound(i, { team: on ? true : undefined })}
                            testId={`team-${i}`}
                          />
                        )}
                      </div>
                    )}

                    <div className="mt-2 flex justify-end gap-1 border-t border-line pt-2">
                      <button className={iconBtn} disabled={i === 0} onClick={() => move(i)} aria-label={p.up}>
                        <IconArrowUp />
                      </button>
                      <button
                        className={iconBtn}
                        disabled={plan.rounds.length <= 1}
                        onClick={() => {
                          onChange({ ...plan, rounds: plan.rounds.filter((_, j) => j !== i) });
                          setOpenRound(null);
                        }}
                        aria-label={p.remove}
                      >
                        <IconTrash />
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
        <button
          className="ui-press mt-3 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-line text-sm font-bold text-txt-dim hover:border-gold/60 hover:bg-ink hover:text-txt disabled:opacity-40"
          disabled={plan.rounds.length >= GAME.max_rounds}
          onClick={() => {
            onChange({ ...plan, rounds: [...plan.rounds, { ...plan.rounds[plan.rounds.length - 1] }] });
            setOpenRound(plan.rounds.length);
          }}
        >
          <IconPlus size={18} />
          {p.add}
        </button>
      </Disclosure>

      {/* Extras, folded away by default. The editors stay mounted while folded
          so their text and validity survive. */}
      <div data-testid="extras">
        <Disclosure
          title={p.moreOptions}
          open={openMore}
          onToggle={() => setOpenMore((o) => !o)}
          testId="more-options"
          badge={moreBad ? <Chip tone="warn">{p.fix}</Chip> : null}
        >
          <Label>{p.breather}</Label>
          <div className="mt-2 flex gap-2">
            {BREATHERS.map((b) => (
              <button key={b} className={choice(plan.breather_s === b, "flex-1 px-1")} onClick={() => onChange({ ...plan, breather_s: b })}>
                {b === 0 ? p.breatherNone : p.breatherS(b)}
              </button>
            ))}
          </div>

          {hasTeams && (
            <>
              <Label>{p.teams}</Label>
              <div className="mt-2 flex gap-2">
                {TEAM_COUNTS.map((n) => (
                  <button
                    key={n}
                    className={choice((plan.teams ?? TEAMS.teams_default) === n, "flex-1")}
                    onClick={() => onChange({ ...plan, teams: n })}
                    data-testid={`teams-${n}`}
                  >
                    {p.teamsN(n)}
                  </button>
                ))}
              </div>
              <Help>{p.teamsHint}</Help>
            </>
          )}

          {hasPosts && (
            <>
              <Label>{p.qr}</Label>
              <div className="mt-2 flex gap-2">
                {QR_COUNTS.map((n) => (
                  <button key={n} className={choice(plan.qr_posts === n, "flex-1 px-1")} onClick={() => onChange({ ...plan, qr_posts: n })}>
                    {n === 0 ? p.qrNone : n}
                  </button>
                ))}
              </div>
              {plan.qr_posts > 0 && <Help>{p.qrHint}</Help>}
            </>
          )}

          <Label>{no.events.wizard.label}</Label>
          <div className="mt-2 flex gap-2">
            {EVENT_EVERY.map((n) => (
              <button
                key={n}
                className={choice((plan.event_every_s ?? 0) === n, "flex-1 px-1")}
                onClick={() => onChange({ ...plan, event_every_s: n || undefined })}
              >
                {n === 0 ? no.events.wizard.off : no.events.wizard.every(n)}
              </button>
            ))}
          </div>
          {(plan.event_every_s ?? 0) > 0 && <Help>{no.events.wizard.help}</Help>}

          <div className="mt-3 border-t border-line pt-2">
            <Switch label={p.voice} on={props.voice} onChange={props.onVoice} testId="voice" />
            <Help>{p.voiceHint}</Help>
          </div>

          <Disclosure
            title={no.missions.title}
            open={openMissions}
            onToggle={() => setOpenMissions((o) => !o)}
            testId="extras-missions"
            badge={
              missionsBad ? (
                <Chip tone="warn">{p.fix}</Chip>
              ) : missionCount ? (
                <Chip tone="gold">{p.missionsN(missionCount)}</Chip>
              ) : (
                <Chip>{p.missionsDefault}</Chip>
              )
            }
          >
            <MissionsEditor plan={plan} onChange={onChange} packs={props.missionPacks} onSavePack={(name, items) => props.onSave("pack", name, items)} />
          </Disclosure>

          <Disclosure
            title={no.quiz.editor}
            open={openQuiz}
            onToggle={() => setOpenQuiz((o) => !o)}
            testId="extras-quiz"
            badge={
              !props.quizValid ? (
                <Chip tone="warn">{p.fix}</Chip>
              ) : quizCount ? (
                <Chip tone="gold">{no.quiz.count(quizCount)}</Chip>
              ) : (
                <Chip>{p.quizNone}</Chip>
              )
            }
          >
            <p className="text-sm leading-relaxed text-txt-dim">{no.quiz.editorLead}</p>
            <QuizEditor
              compact
              ready
              items={plan.quiz}
              packs={props.quizPacks}
              onChange={(items, valid) => {
                props.onQuizValid(valid);
                const { quiz: _q, ...rest } = plan;
                void _q;
                onChange(items ? { ...rest, quiz: items } : rest);
              }}
              onSavePack={(name, items) => props.onSave("quiz", name, items)}
            />
          </Disclosure>
          {quizCount && !hasPosts ? <Note tone="warn">{no.quiz.needsPosts}</Note> : null}
        </Disclosure>
      </div>

      <SheetFooter>
        <Button variant="ghost" onClick={props.onBack}>
          {t.back}
        </Button>
        <span className="inline-flex items-center gap-1.5 text-sm font-extrabold whitespace-nowrap text-gold-text tabular-nums" data-testid="total">
          <IconClock size={18} />
          {p.total(Math.round(planTotalS(plan) / 60))}
        </span>
        <Button size="lg" className="min-w-32" disabled={!normPlan(plan) || !props.quizValid} onClick={props.onNext}>
          {t.next}
        </Button>
      </SheetFooter>
    </>
  );
}

/** 0010: own exercises for this plan, from a pack or typed; saved as a pack on request. */
function MissionsEditor(props: {
  plan: Plan;
  onChange: (p: Plan) => void;
  packs: { id: string; name: string; items: string[] }[];
  onSavePack: (name: string, items: string[]) => Promise<boolean>;
}) {
  const m = no.missions;
  const [text, setText] = useState((props.plan.missions ?? []).join("\n"));
  const [saved, setSaved] = useState(false);
  const [naming, setNaming] = useState<string | null>(null);
  // A new plan from outside (library, opplegg) replaces the text.
  const planMissions = (props.plan.missions ?? []).join("\n");
  const lastPlan = useRef(planMissions);
  useEffect(() => {
    if (planMissions !== lastPlan.current && planMissions !== text.split("\n").filter((l) => l.trim()).join("\n")) {
       
      setText(planMissions);
    }
    lastPlan.current = planMissions;
  }, [planMissions, text]);
  const lines = text.split("\n").filter((l) => l.trim());
  const items = lines.length ? normMissions(lines) : [];
  const set = (v: string) => {
    setText(v);
    setSaved(false);
    const ls = v.split("\n").filter((l) => l.trim());
    const { missions: _old, ...rest } = props.plan;
    void _old;
    props.onChange(ls.length ? { ...rest, missions: ls } : rest);
  };
  const btn = "ui-press min-h-12 rounded-[var(--radius-ctl)] border border-line bg-ink-2 px-3 text-sm font-bold hover:bg-ink-3 disabled:opacity-40";
  return (
    <div data-testid="missions-editor">
      <p className="text-sm leading-relaxed text-txt-dim">{m.lead}</p>
      <textarea className={cx(field, "mt-2 min-h-28 text-sm font-bold")} placeholder={m.field} value={text} onChange={(e) => set(e.target.value)} />
      {items === null && <p className="mt-1 text-xs font-bold text-warn-text">{m.invalid}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        {props.packs.map((pk) => (
          <button key={pk.id} className={btn} onClick={() => set(pk.items.join("\n"))}>
            {m.fromPack}: {pk.name}
          </button>
        ))}
        {items && items.length > 0 && naming === null && (
          <button className={btn} onClick={() => setNaming("")}>
            {saved ? m.saved : m.savePack}
          </button>
        )}
      </div>
      {naming !== null && (
        <form
          className="mt-2 flex flex-wrap gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (items && naming.trim() && (await props.onSavePack(naming, items))) {
              setSaved(true);
              setNaming(null);
            }
          }}
        >
          <input
            className={cx(field, "min-w-40 flex-1 text-sm font-bold")}
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
