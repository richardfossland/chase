// TS twin of chase.kh() and the pure rules in supabase/migrations/0017_hotcold.sql
// (CLAUDE.md rule 2): Snus (is the target within 50 m?) and Termometer (warmer or
// colder than ~30 s ago?). The server decides; the client only shows the answer.
// test/hotcold.test.ts diffs HOTCOLD against the SQL and runs the same vectors as
// test/sql/0017_hotcold.test.sql.

import { GAME, type RoundMode } from "./game";

export const HOTCOLD = {
  sniff_m: 50,
  cooldown_s: 60,
  anchor_every_s: 20,
  thermo_min_s: 15,
  thermo_max_s: 60,
  tie_m: 5,
  fresh_s: 10,
} as const;

/** Same as the SQL: a fix worse than kg('claim_max_acc_m') gives `bad_acc`; such targets are skipped. */
export function accOk(accM: number): boolean {
  return accM <= GAME.claim_max_acc_m;
}

export const HOTCOLD_KINDS = ["sniff", "thermo"] as const;
export type HotColdKind = (typeof HOTCOLD_KINDS)[number];
export type Trend = "warmer" | "colder" | "same";

/** Same as chase._sniff_answer(). */
export function sniffAnswer(distM: number): boolean {
  return distM <= HOTCOLD.sniff_m;
}

/** Same as chase._thermo_answer(): dThen = old position to the target now, dNow = position now to the target now. */
export function thermoAnswer(dThenM: number, dNowM: number, accM: number | null | undefined): Trend {
  const tol = Math.max(HOTCOLD.tie_m, accM ?? 0);
  if (dNowM < dThenM - tol) return "warmer";
  if (dNowM > dThenM + tol) return "colder";
  return "same";
}

export type HotColdError = "bad_kind" | "not_useful";
/** Same as chase._hc_check(): null = usable (hunter or prey in a tag round). */
export function hotColdCheck(kind: string, mode: RoundMode | null | undefined, role: string): HotColdError | null {
  if (!(HOTCOLD_KINDS as readonly string[]).includes(kind)) return "bad_kind";
  if (mode !== "tag") return "not_useful";
  if (role !== "hunter" && role !== "prey") return "not_useful";
  return null;
}

/** Seconds left of the cooldown (0 = ready), from the last-used time in ms. */
export function cooldownLeftS(usedAtMs: number | null, nowMs: number): number {
  if (usedAtMs === null) return 0;
  return Math.max(0, Math.ceil(HOTCOLD.cooldown_s - (nowMs - usedAtMs) / 1000));
}
