// TS twin of chase.ke() and the pure event rules in
// supabase/migrations/0007_events_powerups.sql (CLAUDE.md rule 2). The server
// decides; the client uses these to explain, draw the countdown and grey out
// power-ups that do not fit. test/events.test.ts diffs EVENTS against the SQL
// and runs the same vectors as test/sql/0007_events_powerups.test.sql.

import type { RoundMode } from "./game";

export const EVENTS = {
  every_default_s: 90,
  every_min_s: 60,
  every_max_s: 300,
  end_margin_s: 15,
  sprint_s: 45,
  sprint_winners: 3,
  sprint_pts: 20,
  sprint_min_m: 40,
  sprint_reach_m: 12,
  sprint_max_acc_m: 25,
  mission_s: 90,
  mission_grace_s: 60,
  mission_pts: 15,
  missions: 6,
  gather_s: 60,
  gather_pts: 10,
  gather_winners: 3,
  storm_s: 30,
  storm_immune_s: 5,
  blackout_s: 45,
  show_done_s: 10,
  inv_max: 2,
  shield_s: 15,
  radar_s: 5,
  decoy_m: 40,
  decoy_s: 30,
  turbo_s: 30,
  badge_gap_s: 30,
} as const;

export const EVENT_KINDS = ["sprint", "mission", "gather", "golden", "storm", "blackout"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
export const POWERUPS = ["shield", "radar", "decoy", "turbo"] as const;
export type Powerup = (typeof POWERUPS)[number];

/** Same as chase._ev_kinds(): what the teacher (auto = false) or the automatic picker may start. */
export function eventKinds(mode: RoundMode, qr: boolean, auto: boolean): EventKind[] {
  // 0013: a relay keeps its runners on the course — only the teacher's missions.
  const out: EventKind[] = mode === "relay" ? [] : ["sprint"];
  if (!auto || qr) out.push("mission");
  if (mode !== "relay") out.push("gather");
  if (mode === "posts" && !auto) out.push("golden");
  if (mode === "tag") out.push("storm", "blackout");
  return out;
}

/** Same as chase._ev_dur(). */
export function eventDurationS(kind: EventKind): number {
  switch (kind) {
    case "sprint": return EVENTS.sprint_s;
    case "mission": return EVENTS.mission_s;
    case "gather": return EVENTS.gather_s;
    case "storm": return EVENTS.storm_s;
    case "blackout": return EVENTS.blackout_s;
    default: return 0;
  }
}

/** Same as chase._ev_prize_pool(). */
export function prizePool(tagAhead: boolean): Powerup[] {
  return tagAhead ? ["shield", "radar", "decoy", "turbo"] : ["turbo"];
}

export type PowerupError = "bad_kind" | "not_playing" | "not_useful";
/** Same as chase._pu_check(): null = usable now. */
export function powerupCheck(kind: string, mode: RoundMode | null | undefined, role: string): PowerupError | null {
  if (!(POWERUPS as readonly string[]).includes(kind)) return "bad_kind";
  if (role === "sitting_out" || role === "referee") return "not_playing";
  if ((kind === "shield" || kind === "decoy") && (mode !== "tag" || role !== "prey")) return "not_useful";
  if (kind === "radar" && (mode !== "tag" || (role !== "hunter" && role !== "prey"))) return "not_useful";
  return null;
}

/** Sprint target reached: within max(12 m, acc) with a fix of at most 25 m. */
export function sprintReached(distM: number, accM: number): boolean {
  return accM <= EVENTS.sprint_max_acc_m && distM <= Math.max(EVENTS.sprint_reach_m, accM);
}

/** Turbo's extra points so far for the metres moved since it started. */
export function turboExtra(metresSinceStart: number, movePerPt: number): number {
  return Math.floor(Math.max(0, metresSinceStart) / movePerPt);
}

/**
 * Badge toasts: the phone shows at most one new badge per badge_gap_s
 * (ADR-024 — the server stores them at once). Returns the badge to show now
 * (if any) and the queue left.
 */
export function nextBadgeToast<T>(queue: T[], lastShownMs: number | null, nowMs: number): { show: T | null; rest: T[] } {
  if (!queue.length) return { show: null, rest: queue };
  if (lastShownMs !== null && nowMs - lastShownMs < EVENTS.badge_gap_s * 1000) return { show: null, rest: queue };
  return { show: queue[0], rest: queue.slice(1) };
}
