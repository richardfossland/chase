// TS twin of chase.kv() and the pure Gjemsel rules in
// supabase/migrations/0023_hide_seek.sql (CLAUDE.md rule 2). Gjemsel is a tag
// variant (`variant: "hide"`): few hunters, a head start for the hiders, no radar,
// Snus/Termometer with a short cooldown, and a «pling» for hiders who stand still.
// The server decides; the client only shows. test/hide.test.ts diffs HIDE against
// the SQL and runs the same vectors as test/sql/0023_hide_seek.test.sql.

export const HIDE = {
  head_min_s: 60,
  head_max_s: 90,
  head_default_s: 75,
  min_after_head_s: 60,
  hunters_div: 6,
  cooldown_s: 30,
  pts_per_min: 10,
  still_s: 90,
  still_r_m: 100,
  still_off_min_m: 20,
  still_off_max_m: 70,
  still_max: 25,
} as const;

/** The choices in the wizard (seconds). */
export const HEAD_STARTS = [60, 75, 90] as const;

/** Same as chase._hide_hunters(): ceil(players / 6), at least 1. */
export function hideHunters(players: number): number {
  return Math.max(1, Math.ceil(Math.max(players, 0) / HIDE.hunters_div));
}

/** Same as chase._hide_points(): 10 points per whole minute hidden after the release. */
export function hidePoints(seconds: number): number {
  return Math.floor(Math.max(seconds, 0) / 60) * HIDE.pts_per_min;
}

/** Same as chase._hide_released(): the hunters may act from the release on. */
export function hideReleased(releaseMs: number | null, nowMs: number): boolean {
  return releaseMs !== null && nowMs >= releaseMs;
}

/** A head start the server accepts: whole seconds, 60–90. */
export function validHeadStart(s: unknown): s is number {
  return typeof s === "number" && Number.isInteger(s) && s >= HIDE.head_min_s && s <= HIDE.head_max_s;
}

/** Shortest round that fits the head start (server: duration ≥ head start + 60 s). */
export function minRoundS(headStartS: number): number {
  return headStartS + HIDE.min_after_head_s;
}

type Pod = { cat: string; entries: { id: string; value: number | null }[] };

/** Same as chase._hide_podiums(): «Mestergjemmer» goes before Orienterer / Flest riktige / Lagspiller / Flest poeng / Lagpall. */
export function hidePodiums(podiums: Pod[], rows: { id: string; hide: number }[], size = 3): Pod[] {
  const entries = rows
    .filter((r) => r.hide > 0)
    .sort((a, b) => b.hide - a.hide || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, size)
    .map((r) => ({ id: r.id, value: r.hide }));
  if (!entries.length) return podiums;
  const out: Pod[] = [];
  let placed = false;
  for (const p of podiums) {
    if (!placed && ["scoreo", "quiz", "teamplay", "points", "team"].includes(p.cat)) {
      out.push({ cat: "hide", entries });
      placed = true;
    }
    out.push(p);
  }
  if (!placed) out.push({ cat: "hide", entries });
  return out;
}
