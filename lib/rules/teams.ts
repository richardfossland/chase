// TS twin of chase.kl() and the pure team rules in
// supabase/migrations/0009_teams_flag_king.sql (CLAUDE.md rule 2). The server
// decides; the client uses these to explain (capture ring, countdowns, hill
// clock). test/teams.test.ts diffs TEAMS against the SQL and runs the same
// vectors as test/sql/0009_teams_flag_king.test.sql.

export const TEAMS = {
  teams_default: 2,
  teams_min: 2,
  teams_max: 4,
  flags_extra: 1,
  flags_max: 5,
  flag_r_m: 15,
  flag_max_acc_m: 25,
  flag_cap_s: 10,
  flag_cap_pts: 10,
  flag_hold_every_s: 30,
  flag_hold_pts: 5,
  spot_gap_m: 40,
  hill_r_m: 20,
  hill_move_s: 150,
  hill_every_s: 10,
  hill_team_pts: 3,
  hill_pts: 1,
  hill_per_act: 6,
  msg_show_s: 30,
  msg_gap_s: 5,
} as const;

export const TEAM_MSGS = ["help", "come", "mine", "ok"] as const;
export type TeamMsgKind = (typeof TEAM_MSGS)[number];

/** Same as chase._is_team_round() (0013: + relay). */
export function isTeamRound(r: { mode?: string; team?: boolean } | null | undefined): boolean {
  return !!r && (r.mode === "flag" || r.mode === "king" || r.mode === "relay" || r.team === true);
}

/** Same as chase._team_snake(): i-th player (0-based, strongest first) → team 1..n. */
export function teamSnake(i: number, n: number): number {
  return Math.floor(i / n) % 2 === 0 ? (i % n) + 1 : n - (i % n);
}

/** Same as chase._team_majority(): the team (1-based) with strictly most players, else null. */
export function teamMajority(counts: number[]): number | null {
  if (!counts.length) return null;
  const top = Math.max(...counts);
  if (top <= 0 || counts.filter((c) => c === top).length !== 1) return null;
  return counts.indexOf(top) + 1;
}

/** Same as chase._team_pick(): smallest team, then fewest points, then lowest number. */
export function teamPick(counts: number[], points: number[]): number {
  let best = 0;
  for (let i = 1; i < counts.length; i++) {
    const a = [counts[i], points[i] ?? 0];
    const b = [counts[best], points[best] ?? 0];
    if (a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])) best = i;
  }
  return best + 1;
}

export interface PodiumLike {
  cat: string;
  entries: { id: string; value: number | null }[];
}

/** Same as chase._team_podiums(): «Lagspiller» before «Poeng», «Lagpall» last. */
export function teamPodiums(
  podiums: PodiumLike[],
  teams: { id: string; n: number; points: number }[],
  rows: { id: string; teamplay: number }[],
): PodiumLike[] {
  if (teams.length < 2) return podiums;
  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const tp = rows
    .filter((r) => r.teamplay > 0)
    .sort((a, b) => b.teamplay - a.teamplay || byId(a, b))
    .slice(0, 3)
    .map((r) => ({ id: r.id, value: r.teamplay }));
  const tm = [...teams].sort((a, b) => b.points - a.points || a.n - b.n).map((t) => ({ id: t.id, value: t.points }));
  const out: PodiumLike[] = [];
  let pending = tp.length ? { cat: "teamplay", entries: tp } : null;
  for (const p of podiums) {
    if (p.cat === "points" && pending) {
      out.push(pending);
      pending = null;
    }
    out.push(p);
  }
  if (pending) out.push(pending);
  out.push({ cat: "team", entries: tm });
  return out;
}

/** Seconds left of a flag capture (null = nobody is taking it). Server times; stands still while paused. */
export function captureLeftS(capSince: string | null, offsetMs: number, nowMs: number, frozenAt: string | null = null): number | null {
  if (!capSince) return null;
  const ref = frozenAt ? Date.parse(frozenAt) : nowMs + offsetMs;
  return Math.max(0, Math.ceil(TEAMS.flag_cap_s - (ref - Date.parse(capSince)) / 1000));
}
