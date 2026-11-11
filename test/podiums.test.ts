import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PODIUM, podiumsFrom, type PodiumRow } from "@/lib/rules/podiums";

const sql = readFileSync(new URL("../supabase/migrations/0006_ceremony_overrides.sql", import.meta.url), "utf8");

describe("PODIUM twin of chase.kc()", () => {
  const body = sql.slice(sql.indexOf("function chase.kc("), sql.indexOf("end::real;", sql.indexOf("function chase.kc(")));
  const pairs = [...body.matchAll(/when '([a-z0-9_]+)'\s+then ([0-9.]+)/g)].map((m) => [m[1], Number(m[2])] as const);
  it("has exactly the same keys and values as the SQL", () => {
    expect(pairs.length).toBe(6);
    expect(Object.fromEntries(pairs)).toEqual(PODIUM);
  });
});

// Same vector as test/sql/0006_ceremony_overrides.test.sql.
const rows: PodiumRow[] = [
  { id: "a", points: 100, distance_m: 1200, active_s: 900, catches: 3, survival_s: 50, posts: 4, explorer: 30, comeback: 20 },
  { id: "b", points: 90, distance_m: 1500, active_s: 950, catches: 0, survival_s: 120, posts: 6, explorer: 10, comeback: 0 },
  { id: "c", points: 80, distance_m: 800, active_s: 600, catches: 5, survival_s: 0, posts: 2, explorer: 25, comeback: 40 },
  { id: "d", points: 10, distance_m: 100, active_s: 30, catches: 0, survival_s: 0, posts: 0, explorer: 2, comeback: 0 },
  { id: "e", points: 0, distance_m: 0, active_s: 0, catches: 0, survival_s: 0, posts: 0, explorer: 0, comeback: 0 },
];

describe("podiumsFrom", () => {
  it("no spreading: top 3 per category, empty ones skipped, reveal order", () => {
    expect(podiumsFrom(rows, false).podiums).toEqual([
      { cat: "explorer", entries: [{ id: "a", value: 30 }, { id: "c", value: 25 }, { id: "b", value: 10 }] },
      { cat: "comeback", entries: [{ id: "c", value: 40 }, { id: "a", value: 20 }] },
      { cat: "posts", entries: [{ id: "b", value: 6 }, { id: "a", value: 4 }, { id: "c", value: 2 }] },
      { cat: "survival_s", entries: [{ id: "b", value: 120 }, { id: "a", value: 50 }] },
      { cat: "catches", entries: [{ id: "c", value: 5 }, { id: "a", value: 3 }] },
      { cat: "active_s", entries: [{ id: "b", value: 950 }, { id: "a", value: 900 }, { id: "c", value: 600 }] },
      { cat: "distance_m", entries: [{ id: "b", value: 1500 }, { id: "a", value: 1200 }, { id: "c", value: 800 }] },
      { cat: "points", entries: [{ id: "a", value: 100 }, { id: "b", value: 90 }, { id: "c", value: 80 }] },
    ]);
  });
  it("spreading: max 2 podiums each, the next in line moves up; referee first", () => {
    const r = podiumsFrom(rows, true, ["r1"]);
    expect(r.podiums).toEqual([
      { cat: "referee", entries: [{ id: "r1", value: null }] },
      { cat: "explorer", entries: [{ id: "d", value: 2 }] },
      { cat: "active_s", entries: [{ id: "d", value: 30 }] },
      { cat: "distance_m", entries: [{ id: "b", value: 1500 }, { id: "a", value: 1200 }, { id: "c", value: 800 }] },
      { cat: "points", entries: [{ id: "a", value: 100 }, { id: "b", value: 90 }, { id: "c", value: 80 }] },
    ]);
    expect(r.best).toEqual({
      a: { cat: "points", share: 20, value: 100 },
      b: { cat: "distance_m", share: 20, value: 1500 },
      c: { cat: "catches", share: 20, value: 5 },
      d: { cat: "distance_m", share: null, value: 100 },
      e: { cat: "joined", share: null, value: null },
    });
  });
  it("everybody gets a card; empty class is fine", () => {
    expect(Object.keys(podiumsFrom(rows, true).best)).toHaveLength(rows.length);
    expect(podiumsFrom([], true)).toEqual({ podiums: [], best: {} });
  });
});
