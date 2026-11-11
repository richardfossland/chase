// TS twin of the shrinking zone in supabase/migrations/0005_zone.sql
// (chase.kz(), _zone_offsets, _zone_radii, _zone_k / _zone_r; CLAUDE.md rule 2).
// The zone is a pure function of time: the server stores centre, radii and the
// absolute phase times at round start; everybody computes the same circle from
// the server clock. test/zone.test.ts diffs ZONE against the SQL and runs the
// same vectors as test/sql/0005_zone.test.sql.

export const ZONE = {
  phases: 3,
  final_frac: 0.25,
  min_r_m: 20,
  warn_s: 20,
  out_every_s: 3,
  bonus_pts: 5,
  slack_m: 15,
  uncertain_acc_m: 30,
  center_tries: 20,
} as const;

/** What the server sends in round.zone. */
export interface ZoneState {
  c: { lat: number; lng: number };
  /** r[0] covers the area, r[1..N] the shrinking circles. */
  r: number[];
  /** Absolute phase start times (ISO), N of them. */
  at: string[];
  /** Set while paused / gathering: the zone clock stops there. */
  frozen_at?: string | null;
}

/** PG round(numeric): half away from zero. */
const pgRound = (x: number, digits = 0) => {
  const f = 10 ** digits;
  return (Math.sign(x) * Math.round(Math.abs(x) * f)) / f;
};

/** Phase start offsets (s) from round start: D·k/(N+1). */
export function zoneOffsets(durationS: number): number[] {
  return Array.from({ length: ZONE.phases }, (_, i) => pgRound((durationS * (i + 1)) / (ZONE.phases + 1)));
}

/** Radii r[0..N] for a centre whose farthest area vertex is r0 away. */
export function zoneRadii(r0: number, areaM2: number): number[] {
  const ra = Math.sqrt(areaM2 / Math.PI);
  return [
    pgRound(r0, 1),
    ...Array.from({ length: ZONE.phases }, (_, i) =>
      pgRound(Math.min(r0, Math.max(ZONE.min_r_m, ra * Math.sqrt(1 - ((1 - ZONE.final_frac) * (i + 1)) / ZONE.phases))), 1),
    ),
  ];
}

/** Phase index at a server time: how many phase times are reached. */
export function zonePhase(z: Pick<ZoneState, "at">, atMs: number): number {
  return z.at.filter((t) => Date.parse(t) <= atMs).length;
}

export interface ZoneNow {
  phase: number;
  r: number;
  /** Next circle and when it applies; null in the final phase. */
  next: { r: number; atMs: number; inS: number } | null;
  /** The next circle is announced (≤ warn_s before). */
  warn: boolean;
}

/** The zone at server time `serverNowMs` (stops at frozen_at while paused). */
export function zoneAt(z: ZoneState, serverNowMs: number): ZoneNow {
  const t = z.frozen_at ? Math.min(serverNowMs, Date.parse(z.frozen_at)) : serverNowMs;
  const phase = zonePhase(z, t);
  const nextAt = phase < z.at.length ? Date.parse(z.at[phase]) : null;
  const next = nextAt === null ? null : { r: z.r[phase + 1], atMs: nextAt, inS: Math.max(0, Math.ceil((nextAt - t) / 1000)) };
  return { phase, r: z.r[phase], next, warn: next !== null && next.inS <= ZONE.warn_s };
}

/** Same benefit of the doubt as the server: dist ≤ r + min(acc, 15); bad fix = inside. */
export function insideZone(distM: number, rM: number, accM: number): boolean {
  return accM > ZONE.uncertain_acc_m || distM <= rM + Math.min(accM, ZONE.slack_m);
}

/** Points taken after `outS` seconds outside, given what the round has. */
export function zonePenalty(outS: number, roundPoints: number): number {
  return Math.min(Math.floor(outS / ZONE.out_every_s), Math.max(0, roundPoints));
}

