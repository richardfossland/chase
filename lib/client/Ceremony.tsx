"use client";

// Ceremony pieces shared by the teacher panel and the phones (0006): one
// podium card, the «ditt beste»-kort, and the phone's whole ceremony screen.
// The server froze everything at «Start seremoni»; this only shows it.

import type { CeremonyView } from "@/lib/client/api";
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

export function PodiumCard({ podium, big = false }: { podium: CeremonyView["revealed"][number]; big?: boolean }) {
  return (
    <div className="w-full rounded-3xl border border-gold/40 bg-ink-2 p-5 text-txt shadow-2xl" data-testid="podium">
      <p className={`${big ? "text-4xl" : "text-2xl"} font-black text-gold`}>{c.cats[podium.cat] ?? podium.cat}</p>
      <ol className="mt-4 space-y-2">
        {podium.entries.map((e) => (
          <li
            key={e.place}
            className={`flex items-center gap-3 rounded-2xl px-4 py-3 ${e.me ? "bg-gold text-on-accent" : "bg-ink-3"} ${
              big && e.place === 1 ? "text-3xl" : "text-xl"
            } font-black`}
          >
            <span>{c.places[e.place - 1] ?? `${e.place}.`}</span>
            {e.color && <span className="inline-block h-5 w-5 flex-none rounded-full border-2 border-white/60" style={{ background: e.color }} aria-hidden />}
            <span className="min-w-0 flex-1 truncate">{e.nickname}</span>
            <span className="tabular-nums opacity-80">{c.value(podium.cat, e.value === null ? null : Number(e.value))}</span>
          </li>
        ))}
      </ol>
      {podium.entries.some((e) => e.me) && <p className="mt-3 text-center text-2xl font-black text-gold">{podium.cat === "team" ? c.yourTeam : c.you}</p>}
    </div>
  );
}

/** The phone's ceremony: intro → latest podium → «ditt beste» + «vil spille igjen». */
export function CeremonyScreen({ view, voted, onVote }: { view: CeremonyView; voted: boolean; onVote: (yes: boolean) => void }) {
  const last = view.revealed[view.revealed.length - 1];
  const cards = view.step > view.total;
  return (
    <div className="flex h-full flex-col items-center gap-4 overflow-y-auto p-5 text-center" data-testid="ceremony">
      <p className="text-sm font-bold uppercase tracking-widest text-gold">{c.title}</p>
      {!cards && view.step === 0 && (
        <div className="my-auto">
          <p className="text-5xl font-black">{c.intro}</p>
          <p className="mt-3 text-xl font-bold opacity-80">{view.total ? c.introBody : c.none}</p>
        </div>
      )}
      {!cards && last && (
        <>
          <p className="font-bold opacity-70">{c.of(view.step, view.total)}</p>
          <div key={view.step} className="w-full animate-[flash_0.6s_ease-out]">
            <PodiumCard podium={last} big />
          </div>
        </>
      )}
      {cards && (
        <div className="my-auto w-full space-y-4" data-testid="best-card">
          <div className="rounded-3xl bg-gold p-6 text-on-accent shadow-2xl">
            <p className="text-sm font-black uppercase tracking-widest">{c.bestTitle}</p>
            <p className="mt-2 text-3xl font-black leading-tight">{bestText(view.best)}</p>
            {view.on_podium && <p className="mt-3 text-xl font-black">{c.onPodium}</p>}
          </div>
          <div className="rounded-3xl border border-line bg-ink-2 p-5">
            {voted ? (
              <p className="text-xl font-black">{c.thanks}</p>
            ) : (
              <>
                <p className="text-xl font-black">{c.again}</p>
                <div className="mt-3 flex gap-3">
                  <button className="flex-1 rounded-2xl bg-ok py-4 text-2xl font-black text-on-accent" onClick={() => onVote(true)} data-testid="again-yes">
                    {c.yes}
                  </button>
                  <button className="flex-1 rounded-2xl bg-ink-3 py-4 text-2xl font-black" onClick={() => onVote(false)} data-testid="again-no">
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
