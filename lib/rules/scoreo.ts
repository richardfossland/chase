// TS twin of chase.ks() and the pure phase 10.7–10.8 rules in
// supabase/migrations/0020_practice_scoreo.sql (CLAUDE.md rule 2): prøverunde
// and poengorientering (score-O). The server decides; the client uses these to
// explain (value bands, penalty preview, the return window). test/scoreo.test.ts
// diffs SCOREO against the SQL and runs the same vectors as
// test/sql/0020_practice_scoreo.test.sql.

export const SCOREO = {
  practice_s: 60,
  so_posts: 12,
  so_bands: 4,
  so_band_pts: 10,
  so_from_base_m: 20,
  so_fixed_min: 3,
  so_return_s: 120,
  so_late_step_s: 10,
  so_late_pen: 5,
  so_cands: 120,
} as const;

/** Same as chase._so_value(): value of a post `d` m from the assembly point; `maxD` = farthest point of the area. */
export function scoreoValue(d: number, maxD: number): number {
  const band = Math.min(SCOREO.so_bands - 1, Math.floor((SCOREO.so_bands * Math.max(d, 0)) / Math.max(maxD, 1)));
  return SCOREO.so_band_pts * (1 + band);
}

/** Same as chase._so_pen(): points lost for arriving `lateS` s after the time limit, never more than the round's points. */
export function scoreoPenalty(lateS: number | null | undefined, base: number): number {
  if (lateS === null || lateS === undefined || lateS <= 0) return 0;
  return Math.max(0, Math.min(base, SCOREO.so_late_pen * Math.ceil(lateS / SCOREO.so_late_step_s)));
}

type Pod = { cat: string; entries: { id: string; value: number | null }[] };

/** Same as chase._scoreo_podiums(): «Orienterer» goes right before Flest riktige / Lagspiller / Flest poeng / Lagpall. */
export function scoreoPodiums(podiums: Pod[], rows: { id: string; so: number }[], size = 3): Pod[] {
  const entries = rows
    .filter((r) => r.so > 0)
    .sort((a, b) => b.so - a.so || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, size)
    .map((r) => ({ id: r.id, value: r.so }));
  if (!entries.length) return podiums;
  const out: Pod[] = [];
  let placed = false;
  for (const p of podiums) {
    if (!placed && ["quiz", "teamplay", "points", "team"].includes(p.cat)) {
      out.push({ cat: "scoreo", entries });
      placed = true;
    }
    out.push(p);
  }
  if (!placed) out.push({ cat: "scoreo", entries });
  return out;
}
