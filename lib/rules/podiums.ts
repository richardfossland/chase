// TS twin of chase.kc() and chase._podiums_from() in
// supabase/migrations/0006_ceremony_overrides.sql (CLAUDE.md rule 2). The
// server computes and freezes the podiums at «Start seremoni»; this twin
// documents the rules and is tested against the same vector
// (test/podiums.test.ts ↔ test/sql/0006_ceremony_overrides.test.sql).

export const PODIUM = {
  podium_size: 3,
  max_podiums: 2,
  best_share_max: 50,
  adjust_max: 100,
  speed_flag_mps: 6.95,
  speed_flag_s: 10,
} as const;

export const STAT_CATS = ["points", "distance_m", "active_s", "catches", "survival_s", "posts", "explorer", "comeback"] as const;
export type StatCat = (typeof STAT_CATS)[number];
export type PodiumCat = StatCat | "referee";

/** Who gets placed first when the spreading rule kicks in (points matter most). */
const ASSIGN: StatCat[] = ["points", "distance_m", "active_s", "catches", "survival_s", "posts", "explorer", "comeback"];
/** Reveal order in the ceremony: warm-up first, points last. */
export const REVEAL: PodiumCat[] = ["referee", "explorer", "comeback", "posts", "survival_s", "catches", "active_s", "distance_m", "points"];
const BEST: StatCat[] = ["distance_m", "active_s", "points", "posts", "catches", "survival_s", "explorer"];

export type PodiumRow = { id: string } & Record<StatCat, number>;
export interface Podium {
  cat: PodiumCat;
  entries: { id: string; value: number | null }[];
}
export interface BestCard {
  cat: StatCat | "joined";
  /** «blant de X %» (rounded up to 10); null = a plain positive line instead. */
  share: number | null;
  value: number | null;
}

/** Same as chase._podiums_from(): podiums in reveal order + everybody's «ditt beste». */
export function podiumsFrom(rows: PodiumRow[], spread: boolean, referees: string[] = []): { podiums: Podium[]; best: Record<string, BestCard> } {
  const count = new Map<string, number>();
  const by = new Map<PodiumCat, Podium["entries"]>();
  for (const cat of ASSIGN) {
    const entries: Podium["entries"] = [];
    const cands = rows
      .filter((r) => (r[cat] ?? 0) > 0)
      .sort((a, b) => b[cat] - a[cat] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const r of cands) {
      if (entries.length >= PODIUM.podium_size) break;
      if (spread && (count.get(r.id) ?? 0) >= PODIUM.max_podiums) continue;
      entries.push({ id: r.id, value: r[cat] });
      count.set(r.id, (count.get(r.id) ?? 0) + 1);
    }
    if (entries.length) by.set(cat, entries);
  }
  if (referees.length) by.set("referee", referees.slice(0, PODIUM.podium_size).map((id) => ({ id, value: null })));
  const podiums = REVEAL.filter((c) => by.has(c)).map((cat) => ({ cat, entries: by.get(cat)! }));

  const n = rows.length;
  const best: Record<string, BestCard> = {};
  for (const r of rows) {
    let pick: BestCard | null = null;
    for (const cat of BEST) {
      const mine = r[cat] ?? 0;
      if (mine <= 0) continue;
      const ge = rows.filter((q) => (q[cat] ?? 0) >= mine).length;
      const share = Math.ceil((ge * 10) / n) * 10;
      if (!pick || share < pick.share!) pick = { cat, share, value: mine };
    }
    if (!pick || pick.share! > PODIUM.best_share_max) {
      pick =
        r.active_s >= 60 ? { cat: "active_s", share: null, value: r.active_s }
        : r.distance_m >= 50 ? { cat: "distance_m", share: null, value: r.distance_m }
        : { cat: "joined", share: null, value: null };
    }
    best[r.id] = pick;
  }
  return { podiums, best };
}
