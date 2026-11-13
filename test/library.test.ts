import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normPlan } from "@/lib/rules/game";
import { LIBRARY, normMissions, normName, parseShareCode, parseTeacherKey, teacherKeyQr } from "@/lib/rules/library";
import { STARTER_PACKS } from "@/lib/starter";
import { generateTeacherKey } from "@/lib/client/identity";

const sql = readFileSync(new URL("../supabase/migrations/0010_library_sharing.sql", import.meta.url), "utf8");

describe("LIBRARY twin of chase.kb()", () => {
  const body = sql.slice(sql.indexOf("function chase.kb("), sql.indexOf("end::real;", sql.indexOf("function chase.kb(")));
  const pairs = [...body.matchAll(/when '([a-z0-9_]+)'\s+then ([0-9.]+)/g)].map((m) => [m[1], Number(m[2])] as const);
  it("has exactly the same keys and values as the SQL", () => {
    expect(pairs.length).toBe(Object.keys(LIBRARY).length);
    expect(Object.fromEntries(pairs)).toEqual(LIBRARY);
  });
});

// Same vectors as test/sql/0010_library_sharing.test.sql.
describe("library rules", () => {
  it("own missions", () => {
    expect(normMissions(["  10 burpees ", "Hopp  tau 30 s", "10 BURPEES"])).toEqual(["10 burpees", "Hopp tau 30 s"]);
    expect(normMissions([])).toBeNull();
    expect(normMissions(["a"])).toBeNull();
    expect(normMissions(["x".repeat(81)])).toBeNull();
    expect(normMissions(["ok ok", 5])).toBeNull();
    expect(normMissions("10 burpees")).toBeNull();
    expect(normMissions(Array.from({ length: 13 }, (_, i) => `Øvelse ${i + 1}`))).toBeNull();
    expect(normMissions(Array.from({ length: 12 }, (_, i) => `Øvelse ${i + 1}`))).toHaveLength(12);
  });
  it("names", () => {
    expect(normName("  Skolegården   nord ")).toBe("Skolegården nord");
    expect(normName("   ")).toBeNull();
    expect(normName("x".repeat(81))).toBeNull();
  });
  it("plan with missions", () => {
    expect(normPlan({ rounds: [{ mode: "posts", duration_s: 300 }], missions: ["10 burpees", " 5 push-ups"] })?.missions).toEqual(["10 burpees", "5 push-ups"]);
    expect(normPlan({ rounds: [{ mode: "posts", duration_s: 300 }], missions: [] })?.missions).toBeUndefined();
    expect(normPlan({ rounds: [{ mode: "posts", duration_s: 300 }], missions: ["x"] })).toBeNull();
    expect(normPlan({ rounds: [{ mode: "flag", duration_s: 300 }], missions: ["Spurt 20 m"] })?.teams).toBe(2);
  });
  it("share codes and teacher keys", () => {
    expect(parseShareCode("abcd2345")).toBe("ABCD2345");
    expect(parseShareCode("https://chase.sundaysuite.app/d/ABCD2345")).toBe("ABCD2345");
    expect(parseShareCode("ABCD-1234")).toBeNull();
    const k = generateTeacherKey();
    expect(parseTeacherKey(k)).toBe(k);
    expect(parseTeacherKey(teacherKeyQr(k))).toBe(k);
    expect(parseTeacherKey(k.toLowerCase().replace(/-/g, " "))).toBe(k);
    expect(parseTeacherKey("ABCD-EFGH")).toBeNull();
  });
});

describe("start packs", () => {
  it("every pack is a valid plan the server accepts unchanged", () => {
    expect(STARTER_PACKS.map((p) => p.id)).toEqual(["skolegard", "skog", "sentrum", "kirkeleir"]);
    for (const p of STARTER_PACKS) {
      expect(normPlan(p.plan), p.id).toEqual(p.plan);
      expect(p.radius_m).toBeGreaterThanOrEqual(50);
      expect(p.radius_m).toBeLessThanOrEqual(400);
    }
  });
});
