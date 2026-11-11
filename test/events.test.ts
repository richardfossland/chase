import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GAME } from "@/lib/rules/game";
import { EVENTS, eventDurationS, eventKinds, nextBadgeToast, powerupCheck, prizePool, sprintReached, turboExtra } from "@/lib/rules/events";

const sql = readFileSync(new URL("../supabase/migrations/0007_events_powerups.sql", import.meta.url), "utf8");

describe("EVENTS twin of chase.ke()", () => {
  const body = sql.slice(sql.indexOf("function chase.ke("), sql.indexOf("end::real;", sql.indexOf("function chase.ke(")));
  const pairs = [...body.matchAll(/when '([a-z0-9_]+)'\s+then ([0-9.]+)/g)].map((m) => [m[1], Number(m[2])] as const);
  it("has exactly the same keys and values as the SQL", () => {
    expect(pairs.length).toBe(Object.keys(EVENTS).length);
    expect(Object.fromEntries(pairs)).toEqual(EVENTS);
  });
});

// Same vectors as test/sql/0007_events_powerups.test.sql.
describe("event rules", () => {
  it("kinds per mode, teacher vs automatic", () => {
    expect(eventKinds("free", false, false)).toEqual(["sprint", "mission", "gather"]);
    expect(eventKinds("free", false, true)).toEqual(["sprint", "gather"]);
    expect(eventKinds("free", true, true)).toEqual(["sprint", "mission", "gather"]);
    expect(eventKinds("posts", false, false)).toEqual(["sprint", "mission", "gather", "golden"]);
    expect(eventKinds("posts", true, true)).toEqual(["sprint", "mission", "gather"]);
    expect(eventKinds("tag", false, false)).toEqual(["sprint", "mission", "gather", "storm", "blackout"]);
    expect(eventKinds("tag", false, true)).toEqual(["sprint", "gather", "storm", "blackout"]);
  });
  it("durations", () => {
    expect((["sprint", "mission", "gather", "golden", "storm", "blackout"] as const).map(eventDurationS)).toEqual([45, 90, 60, 0, 30, 45]);
  });
  it("prize pool", () => {
    expect(prizePool(true)).toEqual(["shield", "radar", "decoy", "turbo"]);
    expect(prizePool(false)).toEqual(["turbo"]);
  });
  it("power-up checks", () => {
    expect(powerupCheck("shield", "tag", "prey")).toBeNull();
    expect(powerupCheck("shield", "tag", "hunter")).toBe("not_useful");
    expect(powerupCheck("shield", "posts", "neutral")).toBe("not_useful");
    expect(powerupCheck("radar", "tag", "hunter")).toBeNull();
    expect(powerupCheck("radar", "posts", "neutral")).toBe("not_useful");
    expect(powerupCheck("decoy", "tag", "prey")).toBeNull();
    expect(powerupCheck("decoy", "tag", "hunter")).toBe("not_useful");
    expect(powerupCheck("turbo", "posts", "neutral")).toBeNull();
    expect(powerupCheck("turbo", "tag", "sitting_out")).toBe("not_playing");
    expect(powerupCheck("rocket", "tag", "prey")).toBe("bad_kind");
  });
  it("sprint reach and turbo", () => {
    expect(sprintReached(10, 5)).toBe(true);
    expect(sprintReached(20, 22)).toBe(true);
    expect(sprintReached(20, 15)).toBe(false);
    expect(sprintReached(0, 40)).toBe(false);
    expect(turboExtra(120, GAME.move_m_per_pt)).toBe(2);
    expect(turboExtra(-5, GAME.move_m_per_pt)).toBe(0);
  });
  it("one badge toast per 30 s", () => {
    expect(nextBadgeToast(["a", "b"], null, 0)).toEqual({ show: "a", rest: ["b"] });
    expect(nextBadgeToast(["b"], 0, 10_000)).toEqual({ show: null, rest: ["b"] });
    expect(nextBadgeToast(["b"], 0, 30_000)).toEqual({ show: "b", rest: [] });
    expect(nextBadgeToast([], null, 0)).toEqual({ show: null, rest: [] });
  });
});
