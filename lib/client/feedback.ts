"use client";

// Feedback system (PLAN §13 phase 2): one place that turns game events into
// sound + vibration. Visual flashes live in the views. iOS has no vibration
// (CLAUDE.md rule 9), so every cue must also be audible or visible.

import { vibrate } from "@/lib/client/gps";
import { playBadge, playBeep, playBlip, playClaim, playFanfare, playGo, playWhistle } from "@/lib/client/sound";

export type Cue = "claim" | "golden" | "lost" | "beep" | "go" | "roundEnd" | "badge";

const PLAN: Record<Cue, { sound: () => void; vibe?: number | number[] }> = {
  claim: { sound: playClaim, vibe: [60, 40, 120] },
  golden: { sound: playFanfare, vibe: [200, 80, 200, 80, 400] },
  lost: { sound: playBlip, vibe: 80 },
  beep: { sound: playBeep, vibe: 40 },
  go: { sound: playGo, vibe: 400 },
  roundEnd: { sound: playWhistle, vibe: [300, 100, 300] },
  badge: { sound: playBadge, vibe: [30, 30, 30] },
};

export function cue(c: Cue): void {
  const p = PLAN[c];
  p.sound();
  if (p.vibe !== undefined) vibrate(p.vibe);
}
