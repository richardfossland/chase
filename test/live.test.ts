import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LIVE, liveBonus, liveMult, liveNextS } from "@/lib/rules/live";

const sql = readFileSync(new URL("../supabase/migrations/0024_live_rewards.sql", import.meta.url), "utf8");

describe("LIVE twin of chase.klv()", () => {
  const start = sql.indexOf("function chase.klv(");
  const body = sql.slice(start, sql.indexOf("end::real;", start));
  const pairs = [...body.matchAll(/when '([a-z0-9_]+)'\s+then ([0-9.]+)/g)].map((m) => [m[1], Number(m[2])] as const);
  it("has exactly the same keys and values as the SQL", () => {
    expect(pairs.length).toBe(Object.keys(LIVE).length);
    expect(Object.fromEntries(pairs)).toEqual(LIVE);
  });
});

// Same vectors as test/sql/0024_live_rewards.test.sql.
describe("live rules", () => {
  it("multiplier steps at 2 and 4 minutes", () => {
    expect([0, 119.9, 120, 239, 240, 900].map(liveMult)).toEqual([1, 1, 1.25, 1.25, 1.5, 1.5]);
  });
  it("seconds to the next step", () => {
    expect([0, 100.2, 120, 239.5, 240].map(liveNextS)).toEqual([120, 20, 120, 1, null]);
  });
  it("bonus carries the fraction and never goes negative", () => {
    expect(liveBonus(10, 1.25, 0)).toEqual([2, 0.5]);
    expect(liveBonus(3, 1.25, 0.5)).toEqual([1, 0.25]);
    expect(liveBonus(10, 1, 0)).toEqual([0, 0]);
    expect(liveBonus(-5, 1.5, 0.25)).toEqual([0, 0.25]);
    expect(liveBonus(10, 1.5, 0)).toEqual([5, 0]);
  });
});
