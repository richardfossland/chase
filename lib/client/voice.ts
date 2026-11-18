"use client";

// Talte varsler (PLAN §13 fase 9.3). speechSynthesis er et TILLEGG til lyd,
// vibrasjon og blink (CLAUDE.md regel 4): ingenting her kan erstatte, forsinke
// eller skjule et sikkerhetsvarsel. Alle kall til speechSynthesis ligger i
// try/catch, så en manglende eller kastende talemotor aldri påvirker resten.
// Sier ingenting med mindre læreren har slått det på (view.voice === true).

import type { SessionStatus } from "@/lib/client/api";
import { no } from "@/lib/locale/no";

export type VoiceKey = "forbidden" | "outside" | "zoneOut" | "zoneShrink" | "caught" | "foxNow" | "hunterNear" | "go" | "gather";

/** Viktigste først. Bare den første sies når flere utløses i samme tick. */
const PRIORITY: VoiceKey[] = ["forbidden", "outside", "zoneOut", "zoneShrink", "caught", "foxNow", "hunterNear", "go", "gather"];

/** Utvalget av en elevvisning som setningsvalget trenger. */
export interface VoiceView {
  status: SessionStatus;
  role: string;
  voice?: boolean;
  safety: { geofence: number; forbidden: boolean };
  tag?: { hunter_near?: boolean; fox?: boolean } | null;
  zone?: { inside: boolean } | null;
}

/**
 * Hvilke setninger skal sies nå? Ren funksjon av forrige og nåværende visning.
 * Tom liste når voice er av, når det ikke finnes en forrige visning, eller når ingenting nytt har skjedd.
 * `storm`: rollebytte under en storm-hendelse er ikke «fanget».
 */
export function voiceLinesFor(prev: VoiceView | null, next: VoiceView, opts: { storm?: boolean } = {}): VoiceKey[] {
  if (next.voice !== true || !prev) return [];
  const out = new Set<VoiceKey>();
  const live = prev.status === "live" && next.status === "live";

  if (next.safety.forbidden && !prev.safety.forbidden) out.add("forbidden");
  else if (next.safety.geofence >= 2 && prev.safety.geofence < 2 && !next.safety.forbidden) out.add("outside");

  if (live && next.zone && prev.zone && prev.zone.inside && !next.zone.inside) out.add("zoneOut");

  if (live && !opts.storm) {
    if (prev.role === "prey" && next.role === "hunter") out.add("caught");
    else if (prev.role === "hunter" && next.role === "prey" && next.tag?.fox) out.add("foxNow");
  }
  if (next.tag?.hunter_near && !prev.tag?.hunter_near) out.add("hunterNear");

  if (next.status === "live" && (prev.status === "countdown" || prev.status === "breather")) out.add("go");
  if (next.status === "gathering" && prev.status !== "gathering") out.add("gather");

  return PRIORITY.filter((k) => out.has(k));
}

/** Velg norsk stemme om den finnes (nb-NO, så nb/no/nn), ellers null = nettleserens standard for nb-NO. */
export function pickVoice<T extends { lang: string }>(voices: readonly T[]): T | null {
  const norm = (l: string) => l.toLowerCase().replace("_", "-");
  const exact = voices.find((v) => norm(v.lang) === "nb-no");
  if (exact) return exact;
  return voices.find((v) => /^(nb|no|nn)(-|$)/.test(norm(v.lang))) ?? null;
}

function synth(): SpeechSynthesis | null {
  try {
    return typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;
  } catch {
    return null;
  }
}

/** Kalles i «Jeg er klar»-trykket: iOS krever en brukergest før første ytring. */
export function unlockVoice(): void {
  try {
    const s = synth();
    if (!s) return;
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    u.lang = "nb-NO";
    s.speak(u);
  } catch {
    /* ingen tale: lyd og blink gjør jobben */
  }
}

/** Si én kort setning. Avbryter forrige ytring. Feil svelges alltid. */
export function speak(text: string): void {
  try {
    const s = synth();
    if (!s) return;
    s.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "nb-NO";
    u.rate = 1.05;
    const v = pickVoice(s.getVoices());
    if (v) u.voice = v;
    s.speak(u);
  } catch {
    /* ingen tale: lyd og blink gjør jobben */
  }
}

export function speakKey(key: VoiceKey): void {
  try {
    speak(no.voice[key]);
  } catch {
    /* aldri la tale påvirke varslene */
  }
}

/** Si den viktigste av setningene. Kalles bare med utfall fra voiceLinesFor. */
export function speakLines(keys: readonly VoiceKey[]): void {
  if (keys.length) speakKey(keys[0]);
}
