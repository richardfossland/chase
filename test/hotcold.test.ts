import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HOTCOLD, accOk, cooldownLeftS, hotColdCheck, sniffAnswer, thermoAnswer } from "@/lib/rules/hotcold";

const sql = readFileSync(new URL("../supabase/migrations/0017_hotcold.sql", import.meta.url), "utf8");

describe("HOTCOLD twin of chase.kh()", () => {
  const body = sql.slice(sql.indexOf("function chase.kh("), sql.indexOf("end::real;", sql.indexOf("function chase.kh(")));
  const pairs = [...body.matchAll(/when '([a-z0-9_]+)'\s+then ([0-9.]+)/g)].map((m) => [m[1], Number(m[2])] as const);
  it("has exactly the same keys and values as the SQL", () => {
    expect(pairs.length).toBe(Object.keys(HOTCOLD).length);
    expect(Object.fromEntries(pairs)).toEqual(HOTCOLD);
  });
});

// Same vectors as test/sql/0017_hotcold.test.sql.
describe("hot/cold rules", () => {
  it("sniff: 50 m is inside, 51 m is not", () => {
    expect([0, 49, 50, 51, 200].map(sniffAnswer)).toEqual([true, true, true, false, false]);
  });
  it("thermometer with acc 5", () => {
    expect(thermoAnswer(100, 80, 5)).toBe("warmer");
    expect(thermoAnswer(100, 120, 5)).toBe("colder");
    expect(thermoAnswer(100, 97, 5)).toBe("same");
    expect(thermoAnswer(100, 95, 5)).toBe("same");
    expect(thermoAnswer(100, 94, 5)).toBe("warmer");
  });
  it("thermometer: GPS accuracy widens the tie", () => {
    expect(thermoAnswer(100, 85, 20)).toBe("same");
    expect(thermoAnswer(100, 70, 20)).toBe("warmer");
    expect(thermoAnswer(100, 130, null)).toBe("colder");
  });
  it("who can use it", () => {
    expect(hotColdCheck("sniff", "tag", "hunter")).toBeNull();
    expect(hotColdCheck("thermo", "tag", "prey")).toBeNull();
    expect(hotColdCheck("thermo", "posts", "neutral")).toBe("not_useful");
    expect(hotColdCheck("sniff", "tag", "sitting_out")).toBe("not_useful");
    expect(hotColdCheck("sniff", "tag", "referee")).toBe("not_useful");
    expect(hotColdCheck("radar", "tag", "hunter")).toBe("bad_kind");
  });
  it("bad GPS accuracy limit", () => {
    expect([5, 25, 25.1, 60].map(accOk)).toEqual([true, true, false, false]);
  });
  it("cooldown", () => {
    expect(cooldownLeftS(null, 1000)).toBe(0);
    expect(cooldownLeftS(0, 59_500)).toBe(1);
    expect(cooldownLeftS(0, 60_000)).toBe(0);
    expect(cooldownLeftS(0, 10_000)).toBe(50);
  });
});
