// Small, dependency-free geo toolkit for game-sized areas (< a few km).
//
// This is the TS twin of the PostGIS geography maths the server uses
// (ST_Distance / ST_Covers on geography). Over a school yard or a forest the
// local equirectangular projection used here is accurate to well under 0.5 %,
// far below GPS noise (5–30 m). Keep the semantics aligned with the SQL side:
// distances in metres, coordinates as [lng, lat] (GeoJSON order).

export type LngLat = readonly [lng: number, lat: number];
/** A simple ring of positions. Closing point optional (first === last is fine). */
export type Ring = readonly LngLat[];

/** Mean Earth radius (m) — the same sphere PostGIS uses for `use_spheroid=false`. */
export const EARTH_RADIUS_M = 6_371_008.8;

const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

/** Great-circle distance in metres. */
export function haversine(a: LngLat, b: LngLat): number {
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Local tangent-plane projection centred on `origin`: x = east (m), y = north (m). */
export function makeProjection(origin: LngLat) {
  const kx = toRad(1) * EARTH_RADIUS_M * Math.cos(toRad(origin[1]));
  const ky = toRad(1) * EARTH_RADIUS_M;
  return {
    toXY: (p: LngLat): [number, number] => [(p[0] - origin[0]) * kx, (p[1] - origin[1]) * ky],
    toLngLat: (x: number, y: number): LngLat => [origin[0] + x / kx, origin[1] + y / ky],
  };
}

function openRing(ring: Ring): Ring {
  if (ring.length > 1) {
    const f = ring[0];
    const l = ring[ring.length - 1];
    if (f[0] === l[0] && f[1] === l[1]) return ring.slice(0, -1);
  }
  return ring;
}

/** Arithmetic centroid of the ring's vertices (good enough as a projection origin). */
export function ringCenter(ring: Ring): LngLat {
  const r = openRing(ring);
  let x = 0;
  let y = 0;
  for (const p of r) {
    x += p[0];
    y += p[1];
  }
  return [x / r.length, y / r.length];
}

/** Ray-casting point-in-polygon. Points exactly on an edge count as inside (ST_Covers). */
export function pointInRing(p: LngLat, ring: Ring): boolean {
  const r = openRing(ring);
  if (r.length < 3) return false;
  if (distanceToRingEdge(p, r) < 1e-6) return true;
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i];
    const [xj, yj] = r[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Shortest distance (m) from a point to the ring's boundary. */
export function distanceToRingEdge(p: LngLat, ring: Ring): number {
  const r = openRing(ring);
  const proj = makeProjection(p);
  let best = Infinity;
  for (let i = 0; i < r.length; i++) {
    const [ax, ay] = proj.toXY(r[i]);
    const [bx, by] = proj.toXY(r[(i + 1) % r.length]);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    best = Math.min(best, Math.hypot(cx, cy));
  }
  return best;
}

/**
 * Signed distance to the boundary: negative inside, positive outside.
 * The geofence tiers (PLAN §7) are thresholds on this value, widened by GPS accuracy.
 */
export function signedDistanceToRing(p: LngLat, ring: Ring): number {
  const d = distanceToRingEdge(p, ring);
  return pointInRing(p, ring) ? -d : d;
}

/** Planar area (m²) of a ring via the shoelace formula in local projection. */
export function ringArea(ring: Ring): number {
  const r = openRing(ring);
  if (r.length < 3) return 0;
  const proj = makeProjection(ringCenter(r));
  let sum = 0;
  for (let i = 0; i < r.length; i++) {
    const [x1, y1] = proj.toXY(r[i]);
    const [x2, y2] = proj.toXY(r[(i + 1) % r.length]);
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

/** A closed polygon ring approximating a circle (used for "Sirkel rundt meg" and the shrinking zone). */
export function circleRing(center: LngLat, radiusM: number, segments = 64): LngLat[] {
  const proj = makeProjection(center);
  const out: LngLat[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * 2 * Math.PI;
    out.push(proj.toLngLat(radiusM * Math.cos(a), radiusM * Math.sin(a)));
  }
  out.push(out[0]);
  return out;
}

/** Initial bearing in degrees (0 = north, clockwise) — drives the "back inside" arrow. */
export function bearing(from: LngLat, to: LngLat): number {
  const φ1 = toRad(from[1]);
  const φ2 = toRad(to[1]);
  const Δλ = toRad(to[0] - from[0]);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}
