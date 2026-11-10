// TS twin of chase.kt() and the Smittejakt rules in
// supabase/migrations/0004_tag.sql (CLAUDE.md rule 2). The server decides;
// the client uses these to explain (catch radius hint, immunity ring, ping age).
// test/tag.test.ts diffs TAG against the SQL and runs the same vectors.

export const TAG = {
  hunters_frac: 0.15,
  catch_min_m: 30,
  catch_max_m: 50,
  near_m: 30,
  danger_m: 60,
  immune_s: 20,
  catch_pts: 15,
  assist_pts: 5,
  assist_m: 30,
  assist_s: 10,
  survive_every_s: 5,
  survivor_pts: 25,
  ping_s: 30,
  ping_still_s: 10,
  still_ping_after_s: 15,
  stealth_mps: 2,
  fix_fresh_s: 20,
} as const;

export type TagVariant = "convert" | "swap";

/** Hunters dealt at round start: ~15 %, at least 1. */
export function hunterCount(players: number): number {
  return Math.max(1, Math.round(players * TAG.hunters_frac));
}

/** Max catch distance: max(30, accA + accB), capped at 50 m. */
export function catchLimitM(accA: number, accB: number): number {
  return Math.min(TAG.catch_max_m, Math.max(TAG.catch_min_m, accA + accB));
}

/** Seconds between radar pings of a prey (shorter when standing still). */
export function pingIntervalS(stillForS: number): number {
  return stillForS > TAG.still_ping_after_s ? TAG.ping_still_s : TAG.ping_s;
}

/** Survival points for a stint of this many seconds. */
export function survivalPoints(seconds: number): number {
  return Math.floor(seconds / TAG.survive_every_s);
}

/** The catch QR on a prey's screen. The code alone is enough to type. */
export function catchQr(code: string): string {
  return `CHASE-CATCH:${code}`;
}

/** 4-digit code from a scanned catch QR or typed digits, else null. */
export function parseCatch(text: string): string | null {
  const m = text.trim().match(/^(?:CHASE-CATCH:)?\s*(\d{4})$/i) ?? text.replace(/\D/g, "").match(/^(\d{4})$/);
  return m ? m[1] : null;
}
