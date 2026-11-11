// TS twin of chase.kg() and the phase 2 game rules in
// supabase/migrations/0003_playlist_posts_points.sql (CLAUDE.md rule 2);
// the plan's "zone" flag comes from 0005_zone.sql.
// The server decides; the client uses these to explain and to draw (round
// clock, claim ring, wizard totals). test/game.test.ts diffs GAME against the
// SQL and runs the same vectors as test/sql/0003_playlist_posts_points.test.sql.

export const GAME = {
  countdown_s: 10,
  countdown_max_s: 30,
  breather_s: 60,
  breather_max_s: 300,
  round_min_s: 60,
  round_max_s: 1800,
  max_rounds: 10,
  qr_max: 12,
  claim_radius_m: 12,
  claim_max_acc_m: 25,
  claim_hits: 2,
  players_per_post: 4,
  posts_min: 3,
  posts_max: 15,
  post_min_player_m: 25,
  post_min_post_m: 30,
  post_edge_m: 10,
  post_forbidden_m: 10,
  post_outer_frac: 0.6,
  post_value: 10,
  post_value_outer: 20,
  golden_value: 50,
  golden_life_s: 60,
  golden_from: 0.35,
  golden_to: 0.65,
  golden_min_round_s: 120,
  qr_value: 15,
  qr_first_bonus: 5,
  move_m_per_pt: 50,
  move_pts_cap: 20,
  cell_m: 20,
} as const;

export type RoundMode = "free" | "posts" | "tag";
export interface PlanRound {
  mode: RoundMode;
  duration_s: number;
  /** Smittejakt only: «smitte» (convert) or «sisten» (swap). */
  variant?: "convert" | "swap";
  /** Krympende sone on top of the round (0005, lib/rules/zone.ts). */
  zone?: boolean;
}
export interface Plan {
  rounds: PlanRound[];
  countdown_s: number;
  breather_s: number;
  qr_posts: number;
}

/** The wizard's default (decided 2026-11-10): 3 × 6 min Postjakt, 60 s breather. */
export const DEFAULT_PLAN: Plan = {
  rounds: [
    { mode: "posts", duration_s: 360 },
    { mode: "posts", duration_s: 360 },
    { mode: "posts", duration_s: 360 },
  ],
  countdown_s: GAME.countdown_s,
  breather_s: GAME.breather_s,
  qr_posts: 0,
};

/** Ready-made playlists (PLAN §2.1, owner's choice 2026-11-10: «Full gymtime» = variert). */
export const TEMPLATES = {
  first: {
    rounds: [
      { mode: "posts", duration_s: 240 },
      { mode: "tag", duration_s: 300, variant: "convert" },
      { mode: "posts", duration_s: 300, zone: true },
      { mode: "tag", duration_s: 360, variant: "convert", zone: true },
    ],
    countdown_s: GAME.countdown_s,
    breather_s: GAME.breather_s,
    qr_posts: 0,
  },
  gym: {
    rounds: [
      { mode: "free", duration_s: 180 },
      { mode: "posts", duration_s: 360 },
      { mode: "tag", duration_s: 360, variant: "convert" },
      { mode: "posts", duration_s: 360, zone: true },
      { mode: "tag", duration_s: 360, variant: "swap", zone: true },
    ],
    countdown_s: GAME.countdown_s,
    breather_s: GAME.breather_s,
    qr_posts: 0,
  },
} satisfies Record<string, Plan>;
export type TemplateId = keyof typeof TEMPLATES;

/** Same rules as chase._norm_plan(); null = the server would say bad_plan. */
export function normPlan(p: Partial<Plan> & { rounds?: unknown }): Plan | null {
  if (!Array.isArray(p.rounds) || p.rounds.length < 1 || p.rounds.length > GAME.max_rounds) return null;
  const rounds: PlanRound[] = [];
  for (const r of p.rounds as unknown as Array<Record<string, unknown>>) {
    const d = r?.duration_s;
    if ((r?.mode !== "free" && r?.mode !== "posts" && r?.mode !== "tag") || typeof d !== "number" || !Number.isInteger(d)) return null;
    if (d < GAME.round_min_s || d > GAME.round_max_s) return null;
    let out: PlanRound;
    if (r.mode === "tag") {
      const v = r.variant ?? "convert";
      if (v !== "convert" && v !== "swap") return null;
      out = { mode: "tag", duration_s: d, variant: v };
    } else out = { mode: r.mode, duration_s: d };
    if (r.zone !== undefined && r.zone !== null && typeof r.zone !== "boolean") return null;
    if (r.zone === true) out.zone = true;
    rounds.push(out);
  }
  const cd = p.countdown_s ?? GAME.countdown_s;
  const br = p.breather_s ?? GAME.breather_s;
  const qr = p.qr_posts ?? 0;
  const int = (x: unknown, max: number) => typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= max;
  if (!int(cd, GAME.countdown_max_s) || !int(br, GAME.breather_max_s) || !int(qr, GAME.qr_max)) return null;
  return { rounds, countdown_s: cd, breather_s: br, qr_posts: qr };
}

/** Total playlist time in seconds: countdowns + rounds + breathers between rounds. */
export function planTotalS(p: Plan): number {
  const n = p.rounds.length;
  return p.rounds.reduce((s, r) => s + r.duration_s, 0) + n * p.countdown_s + Math.max(0, n - 1) * p.breather_s;
}

/** Open GPS posts the server keeps stocked for this many playing players. */
export function postTarget(players: number): number {
  return Math.max(GAME.posts_min, Math.min(GAME.posts_max, Math.ceil(players / GAME.players_per_post)));
}

/** Claim ring: max(12 m, acc), and no GPS claim at all with a worse fix than 25 m. */
export function claimRadiusM(accM: number): number | null {
  if (accM > GAME.claim_max_acc_m) return null;
  return Math.max(GAME.claim_radius_m, accM);
}

/** Point value of a GPS post from its centre→edge fraction (0 = centre, 1 = edge). */
export function postValue(ratio: number, golden = false): number {
  if (golden) return GAME.golden_value;
  return ratio >= GAME.post_outer_frac ? GAME.post_value_outer : GAME.post_value;
}

/** Movement points earned in a round for this distance. */
export function movePoints(roundDistanceM: number): number {
  return Math.min(GAME.move_pts_cap, Math.floor(roundDistanceM / GAME.move_m_per_pt));
}

/** Points for a physical QR card. */
export function qrValue(first: boolean): number {
  return GAME.qr_value + (first ? GAME.qr_first_bonus : 0);
}

/**
 * Seconds left of the current phase, from server times only (rule 6):
 * `offsetMs` = serverNow − clientNow measured at the last tick.
 */
export function phaseLeftS(phaseEndsAt: string | null | undefined, offsetMs: number, clientNowMs = Date.now()): number | null {
  if (!phaseEndsAt) return null;
  return Math.max(0, Math.ceil((Date.parse(phaseEndsAt) - (clientNowMs + offsetMs)) / 1000));
}

export function formatClock(s: number | null): string {
  if (s === null) return "–:––";
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/** Badge ids awarded by chase._award_badges() / claim_qr(). */
export const BADGES = [
  "first_post", "golden", "posts_5", "qr", "km_1", "active_10", "explorer_25", "first_catch", "catches_5", "survivor", "zone_master",
] as const;
export type Badge = (typeof BADGES)[number];
