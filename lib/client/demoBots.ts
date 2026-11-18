"use client";

// Fase 10.6: «Prøv med boter». Botene kjører i lærerens nettleser via lib/sim og er vanlige spillere mot de
// samme API-ene som elevene (ingen snarveier forbi serveren). Modulen lever på tvers av klientnavigasjon
// (veiviser -> lærerpanel), så svermen overlever router.replace.

export const DEMO_MIN_BOTS = 8;
export const DEMO_MAX_BOTS = 20;
export const DEMO_DEFAULT_BOTS = 12;
/** Samme grense som serveren (purge_expired): demoen er over etter 30 min. */
export const DEMO_MAX_MS = 30 * 60 * 1000;
/** Serveren avslutter demoer fra purge_expired (hvert 15. min), så senest 45 min etter start. */
export const DEMO_END_MS = 45 * 60 * 1000;
/** Demo-boter tikker sjeldnere enn ekte elever for å spare databasen. */
export const DEMO_TICK_MS = 5000;

const FLAG = (sessionId: string) => `chase:demo:${sessionId}`;

export function clampBots(n: number): number {
  if (!Number.isFinite(n)) return DEMO_DEFAULT_BOTS;
  return Math.min(DEMO_MAX_BOTS, Math.max(DEMO_MIN_BOTS, Math.round(n)));
}

export function markDemo(sessionId: string, startedAt = Date.now()) {
  try {
    localStorage.setItem(FLAG(sessionId), String(startedAt));
  } catch {
    /* privat modus: ingen merking etter reload */
  }
}

/** Starttid (ms) hvis denne økta er en demo startet fra denne enheten. */
export function demoStartedAt(sessionId: string): number | null {
  try {
    const v = Number(localStorage.getItem(FLAG(sessionId)));
    return v > 0 ? v : null;
  } catch {
    return null;
  }
}

type Running = { sessionId: string; stop: () => void };
let running: Running | null = null;
let stopTimer: ReturnType<typeof setTimeout> | null = null;

export function demoRunning(sessionId: string): boolean {
  return running?.sessionId === sessionId;
}

export function stopDemoBots() {
  if (stopTimer) clearTimeout(stopTimer);
  stopTimer = null;
  running?.stop();
  running = null;
}

/**
 * Lærerpanelet melder seg på mens det er åpent. Når det lukkes (unmount) stoppes botene etter kort
 * utsettelse, slik at remount (Strict Mode) ikke dreper dem.
 */
export function attachDemoPanel(sessionId: string): () => void {
  if (stopTimer) clearTimeout(stopTimer);
  stopTimer = null;
  const onHide = () => {
    if (running?.sessionId === sessionId) stopDemoBots();
  };
  window.addEventListener("pagehide", onHide);
  return () => {
    window.removeEventListener("pagehide", onHide);
    if (running?.sessionId !== sessionId) return;
    stopTimer = setTimeout(() => {
      if (running?.sessionId === sessionId) stopDemoBots();
    }, 1500);
  };
}

/** Starter n boter i økta (PIN) og stopper dem automatisk etter 30 min. */
export async function startDemoBots(opts: { sessionId: string; pin: string; n: number }) {
  stopDemoBots();
  const { startSwarm, defaultMix, httpTransport } = await import("@/lib/sim");
  const swarm = startSwarm({
    transport: httpTransport(""),
    pin: opts.pin,
    kinds: defaultMix(clampBots(opts.n)),
    tickMs: DEMO_TICK_MS,
    seed: Math.floor(Math.random() * 1_000_000),
    sosAfterS: 120,
    dropoutAfterS: 90,
    dropoutForS: 60,
    namePrefix: "Bot",
  });
  const limit = setTimeout(() => stopDemoBots(), DEMO_MAX_MS);
  running = {
    sessionId: opts.sessionId,
    stop: () => {
      clearTimeout(limit);
      swarm.stop();
    },
  };
  markDemo(opts.sessionId);
  swarm.ready.catch(() => stopDemoBots());
}
