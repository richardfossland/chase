// TS twin of chase.klv() and the pure live-reward rules in supabase/migrations/0024_live_rewards.sql
// (CLAUDE.md rule 2). The server decides; the client only shows. test/live.test.ts diffs LIVE against the SQL
// and runs the same vectors as test/sql/0024_live_rewards.test.sql.

export const LIVE = {
  gap_s: 20,
  t1_s: 120,
  m1: 1.25,
  t2_s: 240,
  m2: 1.5,
  reveal_s: 20,
  close_m: 30,
  flash_every_s: 90,
  flash_jitter_s: 20,
  flash_ttl_s: 30,
  flash_pts: 25,
  flash_min_m: 30,
  flash_max_m: 90,
  team_bonus: 0.25,
} as const;

/** Same as chase._live_mult(): multiplier for a live streak of `accS` seconds. */
export function liveMult(accS: number): 1 | 1.25 | 1.5 {
  const a = Math.max(accS || 0, 0);
  return a >= LIVE.t2_s ? LIVE.m2 : a >= LIVE.t1_s ? LIVE.m1 : 1;
}

/** Same as chase._live_next_s(): seconds to the next step, null at the top. */
export function liveNextS(accS: number): number | null {
  const a = Math.max(accS || 0, 0);
  if (a >= LIVE.t2_s) return null;
  return Math.ceil((a >= LIVE.t1_s ? LIVE.t2_s : LIVE.t1_s) - a);
}

/** Same as chase._live_bonus(): [whole bonus, carried fraction]. No bonus on a non-positive delta. */
export function liveBonus(delta: number, mult: number, frac: number): [number, number] {
  if (!(delta > 0)) return [0, frac || 0];
  const x = delta * (mult - 1) + (frac || 0);
  const b = Math.floor(x);
  return [b, x - b];
}

/** The `live` object of the tick answer. */
export type LiveView = { on: boolean; mult: 1 | 1.25 | 1.5; streak_s: number; next_s: number | null; frozen: boolean; best_streak_s?: number };
