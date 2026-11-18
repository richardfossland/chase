"use client";

import { useEffect, useState } from "react";

import { attachDemoPanel, DEMO_MAX_MS, demoRunning, demoStartedAt, stopDemoBots } from "@/lib/client/demoBots";
import { no } from "@/lib/locale/no";

const d = no.demo;

/** «Demo»-merke i lærerpanelet (fase 10.6). Viser seg bare for økter startet som demo fra denne enheten. */
export default function DemoBadge({ sessionId }: { sessionId: string }) {
  const [started, setStarted] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [botsOn, setBotsOn] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage and the swarm are client-only
    setStarted(demoStartedAt(sessionId));
    setBotsOn(demoRunning(sessionId));
    const detach = attachDemoPanel(sessionId);
    const t = setInterval(() => {
      setNow(Date.now());
      setBotsOn(demoRunning(sessionId));
    }, 5000);
    return () => {
      clearInterval(t);
      detach();
    };
  }, [sessionId]);

  if (started === null) return null;
  const left = Math.max(0, Math.ceil((started + DEMO_MAX_MS - now) / 60000));
  return (
    <div
      className="host-float pointer-events-auto flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 self-start rounded-2xl px-4 py-2 text-sm font-bold"
      data-testid="demo-badge"
    >
      <span className="rounded-full bg-gold px-2.5 py-0.5 text-xs font-black text-on-accent">{d.badge}</span>
      <span className="text-txt-dim">{botsOn ? d.running(left) : d.stopped}</span>
      {botsOn && (
        <button
          className="ui-press min-h-8 rounded-full px-2 font-extrabold text-txt underline"
          onClick={() => {
            stopDemoBots();
            setBotsOn(false);
          }}
        >
          {d.stop}
        </button>
      )}
    </div>
  );
}
