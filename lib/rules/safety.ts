// TS twin of chase.k() in supabase/migrations/0002_session_tick_safety.sql
// (CLAUDE.md rule 2). The server decides; the client uses these only to
// explain state (e.g. "Nær grensa" copy, GPS hints). test/safety.test.ts
// fails if the two drift apart.

export const SAFETY = {
  max_players: 60,
  edge_warn_m: 15,
  outside_alarm_s: 30,
  outside_alarm_m: 40,
  outside_high_m: 100,
  forbidden_margin_m: 15,
  good_acc_m: 25,
  uncertain_acc_m: 50,
  max_speed_mps: 8,
  active_min_mps: 1.2,
  active_max_mps: 7,
  segment_reset_s: 30,
  jitter_min_m: 3,
  still_radius_m: 10,
  still_alert_s: 90,
  signal_uncertain_s: 20,
  signal_alarm_s: 60,
  gather_radius_m: 25,
  message_window_s: 120,
} as const;

export type SafetyKey = keyof typeof SAFETY;

/** Geofence level as tick() computes it (PLAN §7). Distances in metres. */
export function geofenceLevel(opts: {
  inside: boolean;
  edgeDistanceM: number; // distance to the boundary line when inside
  outsideM: number; // distance to the area when outside
  accM: number;
  outsideForS: number; // seconds continuously beyond the accuracy margin
}): 0 | 1 | 2 | 3 {
  if (opts.inside) return opts.edgeDistanceM <= SAFETY.edge_warn_m ? 1 : 0;
  if (opts.outsideM <= opts.accM) return 1;
  if (opts.outsideForS > SAFETY.outside_alarm_s || opts.outsideM > SAFETY.outside_alarm_m) return 3;
  return 2;
}

/** "Possibly inside" a forbidden zone: within min(acc, margin). */
export function inForbidden(distanceToZoneM: number, accM: number): boolean {
  return distanceToZoneM <= Math.min(accM, SAFETY.forbidden_margin_m);
}
