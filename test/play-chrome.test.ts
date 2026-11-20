import { describe, expect, it } from "vitest";
import type { PowerView } from "@/lib/client/api";
import { hasEventsOn, playChrome, sessionTotals } from "@/lib/client/playChrome";

const base = { mode: "posts", variant: null, teamRound: false, hasEvents: false };
const noPower: PowerView = { inv: [], radar_until: null, turbo_until: null, decoy_until: null };

describe("playChrome", () => {
  it("Postjakt: meters and steps, nothing else by default", () => {
    expect(playChrome(base)).toEqual({ headerStats: true, eventStrip: false, powerBar: false, hotCold: false, teamStrip: false, teamMsgBar: false });
  });
  it("other modes hide meters and steps", () => {
    for (const mode of ["tag", "free", "flag", "king", "relay", "scoreo"]) expect(playChrome({ ...base, mode }).headerStats).toBe(false);
  });
  it("Gjemsel only gets the hot/cold bar", () => {
    expect(playChrome({ ...base, mode: "tag", variant: "hide" }).hotCold).toBe(true);
    expect(playChrome({ ...base, mode: "tag", variant: "convert" }).hotCold).toBe(false);
    expect(playChrome({ ...base, mode: "tag", variant: "swap" }).hotCold).toBe(true);
  });
  it("team strips only in team rounds", () => {
    const c = playChrome({ ...base, teamRound: true });
    expect(c.teamStrip && c.teamMsgBar).toBe(true);
    expect(playChrome(base).teamStrip).toBe(false);
  });
  it("event strip and power bar follow events", () => {
    const c = playChrome({ ...base, hasEvents: true });
    expect(c.eventStrip && c.powerBar).toBe(true);
  });
  it("exposes no switch for safety: the banner and SOS are not chrome", () => {
    const keys = Object.keys(playChrome(base));
    expect(keys).not.toContain("safety");
    expect(keys).not.toContain("sos");
  });
});

describe("hasEventsOn", () => {
  it("is off without event or power-ups", () => {
    expect(hasEventsOn(null, noPower)).toBe(false);
    expect(hasEventsOn(undefined, undefined)).toBe(false);
  });
  it("is on with power-ups held or running", () => {
    expect(hasEventsOn(null, { ...noPower, inv: ["radar"] })).toBe(true);
    expect(hasEventsOn(null, { ...noPower, turbo_until: "2026-01-01T00:00:00Z" })).toBe(true);
  });
});

describe("sessionTotals", () => {
  it("rounds and passes badges through", () => {
    const t = sessionTotals({ points: 40, distance_m: 1234.6, active_s: 905.9, posts: 7, round_points: 0, badges: ["golden"] });
    expect(t).toEqual({ distance_m: 1235, active_s: 905, posts: 7, badges: ["golden"] });
  });
  it("is zero without stats", () => {
    expect(sessionTotals(null)).toEqual({ distance_m: 0, active_s: 0, posts: 0, badges: [] });
  });
});
