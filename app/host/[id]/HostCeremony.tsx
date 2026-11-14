"use client";

// Teacher's ceremony (0006): big podium for showing the class, a drumroll on
// «Neste», then «ditt beste» on every phone and the anonymous «vil spille
// igjen» count. Sits under the alarm strip — safety stays on top (rule 4).

import { useState } from "react";

import type { CeremonyView } from "@/lib/client/api";
import { PodiumCard } from "@/lib/client/Ceremony";
import { cue } from "@/lib/client/feedback";
import { no } from "@/lib/locale/no";

import type { HostSession } from "./useHostSession";

const c = no.ceremony;
const DRUM_MS = 1700;

export function HostCeremony({ view, act, onEnd }: { view: CeremonyView; act: HostSession["act"]; onEnd: () => void }) {
  const [drumming, setDrumming] = useState(false);
  const last = view.revealed[view.revealed.length - 1];
  const cards = view.step > view.total;
  const lastPodium = view.step === view.total;

  function next() {
    if (drumming) return;
    if (view.step >= view.total) {
      void act("ceremony_next");   // → «ditt beste» on every phone
      return;
    }
    setDrumming(true);
    cue("drum");
    setTimeout(() => {
      void act("ceremony_next").finally(() => setDrumming(false));
    }, DRUM_MS);
  }

  return (
    <div className="absolute inset-0 z-[5] flex flex-col bg-ink text-txt" data-testid="host-ceremony">
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-y-auto px-4 pt-28 pb-4 text-center lg:pt-20">
        <p className="text-sm font-bold uppercase tracking-widest text-gold">{c.title}</p>
        {drumming ? (
          <p className="animate-pulse text-6xl font-black">{c.intro}</p>
        ) : cards ? (
          <div className="w-full max-w-xl space-y-4">
            <p className="text-3xl font-black">{c.cardsShown}</p>
            {view.again && <p className="text-2xl font-black text-gold" data-testid="again-count">{c.againCount(view.again.yes, view.again.no)}</p>}
            <div className="rounded-2xl border border-line bg-ink-2 p-4">
              <p className="font-black">{c.teacherAgain}</p>
              <div className="mt-3 flex gap-2">
                {[true, false].map((yes) => (
                  <button
                    key={String(yes)}
                    className={`flex-1 rounded-xl py-3 text-lg font-black ${
                      view.again?.teacher === yes ? "bg-gold text-on-accent" : "bg-ink-3"
                    }`}
                    onClick={() => void act("vote_again", { yes })}
                  >
                    {yes ? c.yes : c.no}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : view.step === 0 || !last ? (
          <div>
            <p className="text-5xl font-black">{c.intro}</p>
            <p className="mt-3 text-xl font-bold opacity-80">{view.total ? c.introBody : c.none}</p>
          </div>
        ) : (
          <div className="w-full max-w-xl">
            <p className="mb-3 font-bold opacity-70">{c.of(view.step, view.total)}</p>
            <PodiumCard podium={last} big />
          </div>
        )}
      </div>

      <nav className="grid grid-cols-4 gap-2 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <button
          className="rounded-2xl border border-line bg-ink-2 py-4 font-black disabled:opacity-30"
          disabled={view.step === 0 || drumming}
          onClick={() => void act("ceremony_back")}
        >
          {c.back}
        </button>
        {cards ? (
          <button className="col-span-3 rounded-2xl bg-gold py-4 text-lg font-black text-on-accent" onClick={onEnd} data-testid="ceremony-end">
            ■ {c.end}
          </button>
        ) : (
          <button
            className="col-span-3 rounded-2xl bg-gold py-4 text-lg font-black text-on-accent disabled:opacity-60"
            disabled={drumming}
            onClick={next}
            data-testid="ceremony-next"
          >
            {lastPodium || view.total === 0 ? c.toCards : c.drum}
          </button>
        )}
      </nav>
    </div>
  );
}
