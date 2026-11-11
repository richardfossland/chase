import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ZONE, insideZone, zoneAt, zoneOffsets, zonePenalty, zonePhase, zoneRadii } from "@/lib/rules/zone";

const sql = readFileSync(new URL("../supabase/migrations/0005_zone.sql", import.meta.url), "utf8");

describe("ZONE twin of chase.kz()", () => {
  const body = sql.slice(sql.indexOf("function chase.kz("), sql.indexOf("end::real;", sql.indexOf("function chase.kz(")));
  const pairs = [...body.matchAll(/when '([a-z0-9_]+)'\s+then ([0-9.]+)/g)].map((m) => [m[1], Number(m[2])] as const);
  it("has exactly the same keys and values as the SQL", () => {
    expect(pairs.length).toBe(9);
    expect(Object.fromEntries(pairs)).toEqual(ZONE);
  });
  it("Sonemester badge is awarded in the SQL", () => {
    expect(sql).toContain("'zone_master'");
  });
});

// Same vectors as test/sql/0005_zone.test.sql.
describe("zone maths", () => {
  it("phase offsets D·k/(N+1), PG rounding", () => {
    expect(zoneOffsets(360)).toEqual([90, 180, 270]);
    expect(zoneOffsets(90)).toEqual([23, 45, 68]);
    expect(zoneOffsets(60)).toEqual([15, 30, 45]);
  });
  it("radii shrink to 25 % of the area, clamped", () => {
    expect(zoneRadii(80, 10000)).toEqual([80, 48.9, 39.9, 28.2]);
    expect(zoneRadii(30, 10000)).toEqual([30, 30, 30, 28.2]);
    expect(zoneRadii(500, 100)).toEqual([500, 20, 20, 20]);
  });
  const z = {
    c: { lat: 59.91045, lng: 10.7509 },
    r: [80, 48.9, 39.9, 28.2],
    at: ["2026-11-11T10:01:30Z", "2026-11-11T10:03:00Z", "2026-11-11T10:04:30Z"],
  };
  it("phase from server time", () => {
    expect(zonePhase(z, Date.parse("2026-11-11T10:00:00Z"))).toBe(0);
    expect(zonePhase(z, Date.parse("2026-11-11T10:01:30Z"))).toBe(1);
    expect(zonePhase(z, Date.parse("2026-11-11T10:04:29Z"))).toBe(2);
    expect(zonePhase(z, Date.parse("2026-11-11T11:00:00Z"))).toBe(3);
  });
  it("zoneAt: current circle, next circle, 20 s warning", () => {
    const a = zoneAt(z, Date.parse("2026-11-11T10:01:00Z"));
    expect(a).toEqual({ phase: 0, r: 80, next: { r: 48.9, atMs: Date.parse(z.at[0]), inS: 30 }, warn: false });
    expect(zoneAt(z, Date.parse("2026-11-11T10:01:10Z")).warn).toBe(true);
    const end = zoneAt(z, Date.parse("2026-11-11T10:05:00Z"));
    expect(end.r).toBe(28.2);
    expect(end.next).toBeNull();
    expect(end.warn).toBe(false);
  });
  it("a paused zone stops at frozen_at", () => {
    const p = zoneAt({ ...z, frozen_at: "2026-11-11T10:01:00Z" }, Date.parse("2026-11-11T10:30:00Z"));
    expect(p.phase).toBe(0);
    expect(p.next?.inS).toBe(30);
  });
  it("inside with the server's GPS slack", () => {
    expect(insideZone(30, 28.2, 5)).toBe(true);    // 28.2 + 5
    expect(insideZone(34, 28.2, 5)).toBe(false);
    expect(insideZone(43, 28.2, 20)).toBe(true);   // slack capped at 15
    expect(insideZone(44, 28.2, 20)).toBe(false);
    expect(insideZone(500, 28.2, 60)).toBe(true);  // bad fix: benefit of the doubt
  });
  it("penalty −1 per 3 s, never below 0 for the round", () => {
    expect(zonePenalty(2, 10)).toBe(0);
    expect(zonePenalty(10, 10)).toBe(3);
    expect(zonePenalty(100, 7)).toBe(7);
    expect(zonePenalty(100, -2)).toBe(0);
  });
});
