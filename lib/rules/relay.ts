// TS twin of chase.k8() and the pure phase 8 rules in
// supabase/migrations/0013_relay_fox_scale.sql (CLAUDE.md rule 2): Stafett,
// Sporing and the big-group limits. The server decides; the client uses these
// to explain (post ring, base ring, ping age). test/relay.test.ts diffs RELAY
// against the SQL and runs the same vectors as test/sql/0013_relay_fox_scale.test.sql.

export const RELAY = {
  fox_ping_s: 20,
  fox_radar_m: 150,
  fox_end_pts: 25,
  relay_posts: 5,
  relay_r_m: 15,
  relay_max_acc_m: 25,
  base_r_m: 25,
  per_baton: 5,
  leg_team_pts: 10,
  leg_pts: 5,
  relay_badge_legs: 3,
  baton_max_s: 180,
  mates_max: 20,
  radar_max: 25,
  hunters_max: 40,
} as const;

/** Same as chase._relay_batons(): batons a team of this size runs with at once. */
export function relayBatons(members: number): number {
  if (members <= 0) return 0;
  return Math.max(1, Math.ceil(members / RELAY.per_baton));
}

/** Same as chase._relay_post(): post (0-based) of team n's leg-th leg (0-based) on a k-post course. */
export function relayPost(n: number, leg: number, k: number): number | null {
  if (k <= 0) return null;
  return ((((n - 1) + leg) % k) + k) % k;
}

/** Above this many players the teacher's map draws plain dots and clusters (no name tags). */
export const CROWD_FROM = 80;
