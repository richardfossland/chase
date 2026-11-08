import { describe, expect, it } from "vitest";

import {
  bearing,
  circleRing,
  distanceToRingEdge,
  haversine,
  pointInRing,
  ringArea,
  signedDistanceToRing,
  type LngLat,
} from "@/lib/geo";

// A ~100 m × 100 m square around a point in Oslo (59.91 N).
const ORIGIN: LngLat = [10.75, 59.91];
const dLat = 100 / 111_195; // ≈ 100 m north
const dLng = 100 / (111_195 * Math.cos((59.91 * Math.PI) / 180)); // ≈ 100 m east
const SQUARE: LngLat[] = [
  ORIGIN,
  [ORIGIN[0] + dLng, ORIGIN[1]],
  [ORIGIN[0] + dLng, ORIGIN[1] + dLat],
  [ORIGIN[0], ORIGIN[1] + dLat],
  ORIGIN,
];
const CENTER: LngLat = [ORIGIN[0] + dLng / 2, ORIGIN[1] + dLat / 2];

describe("haversine", () => {
  it("is zero for identical points", () => {
    expect(haversine(ORIGIN, ORIGIN)).toBe(0);
  });
  it("measures ~100 m along a side", () => {
    expect(haversine(SQUARE[0], SQUARE[1])).toBeCloseTo(100, 0);
    expect(haversine(SQUARE[1], SQUARE[2])).toBeCloseTo(100, 0);
  });
  it("matches a known long distance (Oslo → Bergen ≈ 305 km)", () => {
    expect(haversine([10.7522, 59.9139], [5.3221, 60.3913]) / 1000).toBeCloseTo(305, -1);
  });
});

describe("pointInRing / signed distance", () => {
  it("detects inside and outside", () => {
    expect(pointInRing(CENTER, SQUARE)).toBe(true);
    expect(pointInRing([ORIGIN[0] - dLng, ORIGIN[1]], SQUARE)).toBe(false);
  });
  it("counts the boundary as inside (ST_Covers semantics)", () => {
    expect(pointInRing([ORIGIN[0] + dLng / 2, ORIGIN[1]], SQUARE)).toBe(true);
  });
  it("gives ~50 m to the edge from the centre, negative inside", () => {
    expect(distanceToRingEdge(CENTER, SQUARE)).toBeCloseTo(50, 0);
    expect(signedDistanceToRing(CENTER, SQUARE)).toBeCloseTo(-50, 0);
  });
  it("is positive outside", () => {
    const outside: LngLat = [ORIGIN[0] + dLng / 2, ORIGIN[1] - dLat / 5]; // 20 m south
    expect(signedDistanceToRing(outside, SQUARE)).toBeCloseTo(20, 0);
  });
  it("accepts open rings", () => {
    expect(pointInRing(CENTER, SQUARE.slice(0, -1))).toBe(true);
  });
});

describe("area and circles", () => {
  it("computes ~10 000 m² for the square", () => {
    expect(ringArea(SQUARE) / 10_000).toBeCloseTo(1, 2);
  });
  it("builds a closed circle whose area ≈ πr²", () => {
    const ring = circleRing(CENTER, 150, 128);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(ringArea(ring) / (Math.PI * 150 ** 2)).toBeCloseTo(1, 2);
    for (const p of ring) expect(haversine(CENTER, p)).toBeCloseTo(150, 0);
  });
});

describe("bearing", () => {
  it("points north and east", () => {
    expect(bearing(ORIGIN, [ORIGIN[0], ORIGIN[1] + dLat])).toBeCloseTo(0, 3);
    expect(bearing(ORIGIN, [ORIGIN[0] + dLng, ORIGIN[1]])).toBeCloseTo(90, 1);
  });
});
