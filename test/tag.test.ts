import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TAG, catchLimitM, catchQr, hunterCount, parseCatch, pingIntervalS, survivalPoints } from "@/lib/rules/tag";

const sql = readFileSync(new URL("../supabase/migrations/0004_tag.sql", import.meta.url), "utf8");

describe("TAG twin of chase.kt()", () => {
  const body = sql.slice(sql.indexOf("function chase.kt("), sql.indexOf("end::real;", sql.indexOf("function chase.kt(")));
  const pairs = [...body.matchAll(/when '([a-z_]+)'\s+then ([0-9.]+)/g)].map((m) => [m[1], Number(m[2])] as const);
  it("has exactly the same keys and values as the SQL", () => {
    expect(pairs.length).toBeGreaterThan(10);
    expect(Object.fromEntries(pairs)).toEqual(TAG);
  });
});

// Same vectors as test/sql/0004_tag.test.sql.
describe("Smittejakt rules", () => {
  it("hunters ~15 %, at least one", () => {
    expect(hunterCount(10)).toBe(2);
    expect(hunterCount(12)).toBe(2);
    expect(hunterCount(6)).toBe(1);
    expect(hunterCount(1)).toBe(1);
    expect(hunterCount(60)).toBe(9);
  });
  it("catch distance max(30, accA+accB) capped at 50", () => {
    expect(catchLimitM(5, 5)).toBe(30);
    expect(catchLimitM(5, 30)).toBe(35);
    expect(catchLimitM(5, 45)).toBe(50);
    expect(catchLimitM(40, 40)).toBe(50);
  });
  it("ping cadence and survival points", () => {
    expect(pingIntervalS(20)).toBe(10);
    expect(pingIntervalS(5)).toBe(30);
    expect(survivalPoints(26)).toBe(5);
    expect(survivalPoints(4)).toBe(0);
  });
  it("catch QR round-trip and typed codes", () => {
    expect(parseCatch(catchQr("0042"))).toBe("0042");
    expect(parseCatch(" 12 34 ")).toBe("1234");
    expect(parseCatch("123")).toBeNull();
    expect(parseCatch("https://chase.sundaysuite.app/q/x/ABCDE")).toBeNull();
  });
});
