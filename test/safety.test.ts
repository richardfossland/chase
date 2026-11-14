import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SAFETY, geofenceLevel, inForbidden } from "@/lib/rules/safety";

// chase.k() was last redefined in 0013 (max_players 60 → 300).
const sql = readFileSync(new URL("../supabase/migrations/0013_relay_fox_scale.sql", import.meta.url), "utf8");

describe("SAFETY twin of chase.k()", () => {
  const body = sql.slice(sql.indexOf("function chase.k("), sql.indexOf("end::real;", sql.indexOf("function chase.k(")));
  const pairs = [...body.matchAll(/when '([a-z_]+)'\s+then ([0-9.]+)/g)].map((m) => [m[1], Number(m[2])] as const);

  it("has exactly the same keys and values as the SQL", () => {
    expect(pairs.length).toBeGreaterThan(10);
    expect(Object.fromEntries(pairs)).toEqual(SAFETY);
  });
});

// Same vectors as test/sql/0002_session_tick_safety.test.sql.
describe("geofenceLevel", () => {
  const base = { inside: false, edgeDistanceM: 0, outsideM: 0, accM: 5, outsideForS: 0 };
  it("centre and edge", () => {
    expect(geofenceLevel({ ...base, inside: true, edgeDistanceM: 50 })).toBe(0);
    expect(geofenceLevel({ ...base, inside: true, edgeDistanceM: 5 })).toBe(1);
  });
  it("outside within accuracy is only a warning", () => {
    expect(geofenceLevel({ ...base, outsideM: 2 })).toBe(1);
  });
  it("outside beyond accuracy, then alarm after 30 s or 40 m", () => {
    expect(geofenceLevel({ ...base, outsideM: 20 })).toBe(2);
    expect(geofenceLevel({ ...base, outsideM: 20, outsideForS: 31 })).toBe(3);
    expect(geofenceLevel({ ...base, outsideM: 56 })).toBe(3);
  });
});

describe("inForbidden", () => {
  it("counts 'possibly inside' up to min(acc, 15 m)", () => {
    expect(inForbidden(10, 5)).toBe(false);
    expect(inForbidden(10, 12)).toBe(true);
    expect(inForbidden(10, 40)).toBe(true);
    expect(inForbidden(28, 40)).toBe(false);
    expect(inForbidden(0, 0)).toBe(true);
  });
});
