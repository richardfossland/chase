import { distanceToRingEdge, pointInRing, signedDistanceToRing, type LngLat, type Ring } from "../geo";
import { SAFETY } from "../rules/safety";

// Urgent fixes (rule 4, ADR-038): a fix that would raise or escalate a geofence
// or forbidden-zone alarm skips the 1.9 s pacing on the phone and in the room.
//
// The phone already has the session geometry (bootstrap geo) and runs the same
// thresholds as chase.tick (lib/rules/safety.ts), but only to decide *when* to
// send. The server still decides whether there is an alarm; a wrong guess here
// only changes how soon a fix is written, never what it means.

export type SafetyGeo = {
  boundary: { coordinates: number[][][] };
  forbidden: { coordinates: number[][][][] } | null;
};

/** What chase.tick will make of this fix, minus the time rule (30 s outside). */
export type FixSafety = { geofence: 0 | 1 | 2 | 3; forbidden: boolean };

export const SAFE: FixSafety = { geofence: 0, forbidden: false };

function distanceToPolygon(p: LngLat, rings: Ring[]): number {
  // Holes are ignored: inside the outer ring counts as inside (safety first).
  if (rings[0] && pointInRing(p, rings[0])) return 0;
  return Math.min(...rings.map((r) => distanceToRingEdge(p, r)));
}

export function fixSafety(fix: { lat: number; lng: number; acc: number }, geo: SafetyGeo | null | undefined): FixSafety {
  if (!geo) return SAFE;
  const p: LngLat = [fix.lng, fix.lat];
  const acc = Math.max(0, fix.acc);
  const ring = geo.boundary.coordinates[0] as unknown as Ring;
  let geofence: FixSafety["geofence"] = 0;
  if (ring?.length) {
    const d = signedDistanceToRing(p, ring);
    if (d <= 0) geofence = -d <= SAFETY.edge_warn_m ? 1 : 0;
    else if (d <= acc) geofence = 1;
    else geofence = d > SAFETY.outside_alarm_m ? 3 : 2;
  }
  let forbidden = false;
  for (const poly of geo.forbidden?.coordinates ?? []) {
    if (distanceToPolygon(p, poly as unknown as Ring[]) <= Math.min(acc, SAFETY.forbidden_margin_m)) {
      forbidden = true;
      break;
    }
  }
  return { geofence, forbidden };
}

/**
 * True when `next` starts or escalates an alarm compared with what the server
 * last heard: outside beyond the accuracy margin (level 2 starts the 30 s
 * clock), beyond 40 m (level 3), or into a forbidden zone. Coming back is not
 * urgent: clearing an alarm can wait for the normal pace.
 */
export function escalates(prev: FixSafety | null, next: FixSafety): boolean {
  const p = prev ?? SAFE;
  if (next.forbidden && !p.forbidden) return true;
  return next.geofence >= 2 && next.geofence > p.geofence;
}
