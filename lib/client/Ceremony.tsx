"use client";

// Ceremony pieces shared by the teacher panel and the phones (0006): one
// podium card, the «ditt beste»-kort, and the phone's whole ceremony screen.
// The server froze everything at «Start seremoni»; this only shows it.

import { useEffect, useState, type CSSProperties } from "react";

import type { CeremonyView } from "@/lib/client/api";
import { Confetti, cx } from "@/lib/client/ui";
import { no } from "@/lib/locale/no";
import type { BestCard } from "@/lib/rules/podiums";

const c = no.ceremony;

export function bestText(best: BestCard | null): string {
  if (!best) return c.plain.joined;
  if (best.share !== null && best.cat !== "joined" && c.best[best.cat]) return c.best[best.cat](best.share);
  if (best.cat === "active_s" && best.value !== null) return c.plain.active_s(best.value);
  if (best.cat === "distance_m" && best.value !== null) return c.plain.distance_m(best.value);
  return c.plain.joined;
}

/** One podium. `build` (phones) raises the places from the bottom up: 3rd, 2nd, then 1st. */
export function PodiumCard({ podium, big = false, build = false }: { podium: CeremonyView["revealed"][number]; big?: boolean; build?: boolean }) {
  const n = podium.entries.length;
  return (
    <div className="w-full rounded-3xl border border-gold/40 bg-ink-2 p-5 text-txt shadow-2xl" data-testid="podium">
      <p className={`${big ? "text-4xl" : "text-2xl"} font-black text-gold-text`}>{c.cats[podium.cat] ?? podium.cat}</p>
      <ol className={cx("mt-4 space-y-2", build && "p-podium")}>
        {podium.entries.map((e, i) => (
          <li
            key={e.place}
            style={build ? ({ "--i": n - 1 - i } as CSSProperties) : undefined}
            className={`flex items-center gap-3 rounded-2xl px-4 py-3 ${e.me ? "bg-gold text-on-accent" : "bg-ink-3"} ${
              big && e.place === 1 ? "text-3xl" : "text-xl"
            } ${build && e.place === 1 ? "ring-2 ring-gold/70" : ""} font-black`}
          >
            <span>{c.places[e.place - 1] ?? `${e.place}.`}</span>
            {e.color && (
              <span className="inline-block h-5 w-5 flex-none rounded-full border-2 border-white/60" style={{ background: e.color }} aria-hidden />
            )}
            <span className="min-w-0 flex-1 truncate">{e.nickname}</span>
            <span className="tabular-nums opacity-80">{c.value(podium.cat, e.value === null ? null : Number(e.value))}</span>
          </li>
        ))}
      </ol>
      {podium.entries.some((e) => e.me) && (
        <p
          className={cx("mt-3 text-center text-2xl font-black text-gold-text", build && "m-pop")}
          style={build ? { animationDelay: `${n * 380 + 200}ms` } : undefined}
        >
          {podium.cat === "team" ? c.yourTeam : c.you}
        </p>
      )}
    </div>
  );
}

/** The phone's ceremony: intro → latest podium → «ditt beste» + «vil spille igjen». */
export function CeremonyScreen({ view, voted, onVote }: { view: CeremonyView; voted: boolean; onVote: (yes: boolean) => void }) {
  const last = view.revealed[view.revealed.length - 1];
  const cards = view.step > view.total;
  // Confetti starts when the 1st place lands, not when the card appears.
  const [confettiStep, setConfettiStep] = useState(-1);
  const hasLast = !!last;
  const landMs = (last?.entries.length ?? 0) * 380 + 250;
  useEffect(() => {
    if (cards || !hasLast) return;
    const tm = setTimeout(() => setConfettiStep(view.step), landMs);
    return () => clearTimeout(tm);
  }, [view.step, cards, hasLast, landMs]);
  return (
    <div
      className="relative flex h-full flex-col items-center gap-4 overflow-y-auto p-5 pt-[max(1.25rem,env(safe-area-inset-top))] pb-[max(1.25rem,env(safe-area-inset-bottom))] text-center"
      data-testid="ceremony"
    >
      <p className="m-fade-in text-sm font-black uppercase tracking-[0.25em] text-gold-text">{c.title}</p>
      {!cards && view.step === 0 && (
        <div className="m-stagger my-auto">
          <p className="text-5xl font-black" style={{ "--i": 0 } as CSSProperties}>
            <span className="inline-block animate-bounce">{c.intro}</span>
          </p>
          <p className="mt-3 text-xl font-bold text-txt-dim" style={{ "--i": 1 } as CSSProperties}>
            {view.total ? c.introBody : c.none}
          </p>
        </div>
      )}
      {!cards && last && (
        <>
          <p key={`of-${view.step}`} className="m-rise-in font-bold text-txt-dim">
            {c.of(view.step, view.total)}
          </p>
          <div key={`pod-${view.step}`} className="m-scale-in my-auto w-full">
            <PodiumCard podium={last} big build />
          </div>
          {/* Confetti once the 1st place has landed (the podium builds 3 → 2 → 1). */}
          {confettiStep === view.step && <Confetti key={`cf-${view.step}`} pieces={last.entries.some((e) => e.me) ? 90 : 50} seed={view.step} />}
        </>
      )}
      {cards && view.on_podium && <Confetti pieces={70} seed={99} />}
      {cards && (
        <div className="m-stagger my-auto w-full space-y-4" data-testid="best-card">
          <div style={{ "--i": 0 } as CSSProperties}>
            <div className="p-flip-in rounded-3xl bg-gold p-6 text-on-accent shadow-[var(--shadow-float)]">
              <p className="text-sm font-black uppercase tracking-widest">{c.bestTitle}</p>
              <p className="mt-2 text-3xl font-black leading-tight">{bestText(view.best)}</p>
              {view.on_podium && <p className="mt-3 text-xl font-black">{c.onPodium}</p>}
            </div>
          </div>
          <div className="rounded-3xl border border-line bg-ink-2 p-5" style={{ "--i": 1 } as CSSProperties}>
            {voted ? (
              <p className="m-pop text-xl font-black">{c.thanks}</p>
            ) : (
              <>
                <p className="text-xl font-black">{c.again}</p>
                <div className="mt-3 flex gap-3">
                  <button
                    className="ui-press min-h-14 flex-1 rounded-2xl bg-ok py-4 text-2xl font-black text-on-accent"
                    onClick={() => onVote(true)}
                    data-testid="again-yes"
                  >
                    {c.yes}
                  </button>
                  <button
                    className="ui-press min-h-14 flex-1 rounded-2xl bg-ink-3 py-4 text-2xl font-black"
                    onClick={() => onVote(false)}
                    data-testid="again-no"
                  >
                    {c.no}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
