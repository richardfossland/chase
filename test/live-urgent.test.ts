import { describe, expect, it } from "vitest";

import { circleRing, makeProjection, type LngLat } from "@/lib/geo";
import { escalates, fixSafety, SAFE, type SafetyGeo } from "@/lib/live/urgent";
import { clientMsg } from "@/lib/live/protocol";
import { SAFETY } from "@/lib/rules/safety";
import { tickBody } from "@/lib/server/schemas";

// ADR-038: the phone flags a fix urgent when chase.tick would start or escalate
// a geofence or forbidden-zone alarm for it. Same thresholds as lib/rules/safety.ts.

const C: LngLat = [10.75, 59.91];
const proj = makeProjection(C);
const R = 100; // area: circle of 100 m
const zoneC = proj.toLngLat(0, 60);
const geo: SafetyGeo = {
  boundary: { coordinates: [circleRing(C, R, 256) as unknown as number[][]] },
  forbidden: { coordinates: [[circleRing(zoneC, 10, 128) as unknown as number[][]]] },
};
/** A fix d metres from the centre, due east (outside the area when d > R). */
const at = (d: number, acc = 5) => {
  const [lng, lat] = proj.toLngLat(d, 0);
  return { lat, lng, acc };
};

describe("fixSafety mirrors chase.tick's geofence levels (minus the 30 s rule)", () => {
  it.each([
    [0, 5, 0],
    [R - SAFETY.edge_warn_m - 2, 5, 0],
    [R - SAFETY.edge_warn_m + 2, 5, 1],
    [R + 3, 5, 1], // outside, within GPS error: «Nær grensa»
    [R + 8, 5, 2],
    [R + SAFETY.outside_alarm_m - 1, 5, 2],
    [R + SAFETY.outside_alarm_m + 1, 5, 3],
    [R + 30, 35, 1], // poor accuracy keeps it at 1
  ])("%d m from the centre, acc %d → level %d", (d, acc, level) => {
    expect(fixSafety(at(d, acc), geo).geofence).toBe(level);
  });

  it("forbidden: inside, or within min(acc, 15 m) of the zone", () => {
    const f = (y: number, acc: number) => {
      const [lng, lat] = proj.toLngLat(0, y);
      return fixSafety({ lat, lng, acc }, geo).forbidden;
    };
    expect(f(60, 5)).toBe(true); // centre of the zone
    expect(f(60 - 10 - 4, 5)).toBe(true); // 4 m from the edge, acc 5
    expect(f(60 - 10 - 6, 5)).toBe(false);
    expect(f(60 - 10 - 14, 40)).toBe(true); // margin capped at 15 m
    expect(f(60 - 10 - 16, 40)).toBe(false);
  });

  it("no geometry: nothing is urgent", () => {
    expect(fixSafety(at(R + 80), null)).toEqual(SAFE);
  });
});

describe("escalates", () => {
  const s = (d: number, acc = 5) => fixSafety(at(d, acc), geo);
  it("starting the outside clock, crossing 40 m and entering a zone are urgent", () => {
    expect(escalates(null, s(R + 8))).toBe(true);
    expect(escalates(s(R + 8), s(R + 45))).toBe(true);
    expect(escalates(s(0), { geofence: 0, forbidden: true })).toBe(true);
    expect(escalates(s(R - 5), s(R + 45))).toBe(true);
  });
  it("staying out, the edge warning and coming back are not", () => {
    expect(escalates(s(R + 45), s(R + 50))).toBe(false);
    expect(escalates(s(R + 8), s(R + 20))).toBe(false);
    expect(escalates(s(0), s(R - 5))).toBe(false);
    expect(escalates(s(R + 45), s(R - 5))).toBe(false);
    expect(escalates({ geofence: 0, forbidden: true }, { geofence: 0, forbidden: true })).toBe(false);
  });
});

describe("wire format", () => {
  it("the socket fix and the HTTP tick accept the optional urgent flag", () => {
    expect(clientMsg.safeParse({ t: "fix", lat: 59.9, lng: 10.7, acc: 5, urgent: true }).success).toBe(true);
    expect(clientMsg.safeParse({ t: "fix", lat: 59.9, lng: 10.7, acc: 5, urgent: "yes" }).success).toBe(false);
    const b = tickBody.parse({ playerId: "00000000-0000-4000-8000-000000000001", token: "t".repeat(32), lat: 59.9, lng: 10.7, acc: 5, urgent: true });
    expect(b.urgent).toBe(true);
  });
});
