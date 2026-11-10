import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BADGES,
  DEFAULT_PLAN,
  GAME,
  claimRadiusM,
  formatClock,
  movePoints,
  normPlan,
  phaseLeftS,
  planTotalS,
  postTarget,
  postValue,
  qrValue,
} from "@/lib/rules/game";

const sql = readFileSync(new URL("../supabase/migrations/0003_playlist_posts_points.sql", import.meta.url), "utf8");

describe("GAME twin of chase.kg()", () => {
  const body = sql.slice(sql.indexOf("function chase.kg("), sql.indexOf("end::real;", sql.indexOf("function chase.kg(")));
  const pairs = [...body.matchAll(/when '([a-z0-9_]+)'\s+then ([0-9.]+)/g)].map((m) => [m[1], Number(m[2])] as const);
  it("has exactly the same keys and values as the SQL", () => {
    expect(pairs.length).toBeGreaterThan(20);
    expect(Object.fromEntries(pairs)).toEqual(GAME);
  });
  it("badge ids match the SQL", () => {
    for (const b of BADGES) expect(sql).toContain(`'${b}'`);
  });
});

// Same vectors as test/sql/0003_playlist_posts_points.test.sql.
describe("normPlan", () => {
  it("fills defaults", () => {
    expect(normPlan({ rounds: [{ mode: "posts", duration_s: 360 }, { mode: "free", duration_s: 60 }] })).toEqual({
      rounds: [{ mode: "posts", duration_s: 360 }, { mode: "free", duration_s: 60 }],
      countdown_s: 10,
      breather_s: 60,
      qr_posts: 0,
    });
  });
  it("rejects what the server rejects", () => {
    const bad: unknown[] = [
      { rounds: [] },
      { rounds: [{ mode: "tag", duration_s: 300 }] },
      { rounds: [{ mode: "posts", duration_s: 30 }] },
      { rounds: [{ mode: "posts", duration_s: 99999 }] },
      { rounds: [{ mode: "posts", duration_s: "360" }] },
      { rounds: [{ mode: "posts", duration_s: 360.5 }] },
      { rounds: [{ mode: "posts", duration_s: 360 }], breather_s: -1 },
      { rounds: [{ mode: "posts", duration_s: 360 }], qr_posts: 13 },
      { rounds: Array.from({ length: 11 }, () => ({ mode: "free", duration_s: 60 })) },
    ];
    for (const b of bad) expect(normPlan(b as never)).toBeNull();
  });
  it("default plan is valid and ~21 min", () => {
    expect(normPlan(DEFAULT_PLAN)).toEqual(DEFAULT_PLAN);
    expect(planTotalS(DEFAULT_PLAN)).toBe(3 * 360 + 3 * 10 + 2 * 60);
  });
});

describe("rules", () => {
  it("post target ~players/4 within 3–15", () => {
    expect(postTarget(1)).toBe(3);
    expect(postTarget(16)).toBe(4);
    expect(postTarget(17)).toBe(5);
    expect(postTarget(60)).toBe(15);
    expect(postTarget(100)).toBe(15);
  });
  it("claim radius max(12, acc), none above 25 m", () => {
    expect(claimRadiusM(5)).toBe(12);
    expect(claimRadiusM(20)).toBe(20);
    expect(claimRadiusM(30)).toBeNull();
  });
  it("values", () => {
    expect(postValue(0.2)).toBe(10);
    expect(postValue(0.6)).toBe(20);
    expect(postValue(0.1, true)).toBe(50);
    expect(qrValue(true)).toBe(20);
    expect(qrValue(false)).toBe(15);
  });
  it("movement points +1 per 50 m, cap 20", () => {
    expect(movePoints(49)).toBe(0);
    expect(movePoints(60)).toBe(1);
    expect(movePoints(1050)).toBe(20);
  });
  it("round clock from server time", () => {
    const now = Date.parse("2026-11-10T10:00:00Z");
    expect(phaseLeftS("2026-11-10T10:01:00Z", 0, now)).toBe(60);
    expect(phaseLeftS("2026-11-10T10:01:00Z", 5000, now)).toBe(55);  // client 5 s behind server
    expect(phaseLeftS("2026-11-10T09:59:00Z", 0, now)).toBe(0);
    expect(phaseLeftS(null, 0, now)).toBeNull();
    expect(formatClock(65)).toBe("1:05");
  });
});
