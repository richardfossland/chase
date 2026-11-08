import { describe, expect, it } from "vitest";

import { haversine, pointInRing, signedDistanceToRing, type LngLat } from "@/lib/geo";
import { createBot, defaultMix, parseMix, type Behaviour, type SimGeo } from "@/lib/sim/behaviours";

// ~100 × 100 m test square (same as the SQL tests) with a 20 × 20 m forbidden zone.
const ring: LngLat[] = [[10.75, 59.91], [10.7518, 59.91], [10.7518, 59.9109], [10.75, 59.9109], [10.75, 59.91]];
const zone: LngLat[] = [[10.751, 59.9105], [10.75136, 59.9105], [10.75136, 59.91068], [10.751, 59.91068], [10.751, 59.9105]];
const geo: SimGeo = {
  boundary: { coordinates: [ring as unknown as number[][]] },
  forbidden: { coordinates: [[zone as unknown as number[][]]] },
  assembly: { lat: 59.91045, lng: 10.7509 },
};

function run(kind: Behaviour, seconds: number, seed = 1, opts = {}) {
  const bot = createBot(kind, geo, { seed, ...opts });
  const steps = [];
  for (let t = 0; t < seconds; t += 2) steps.push({ ...bot.step(2), true: bot.truePos() });
  return steps;
}
const ll = (p: { lat: number; lng: number }): LngLat => [p.lng, p.lat];

describe("sim behaviours", () => {
  it("is deterministic per seed", () => {
    expect(run("runner", 60, 7)).toEqual(run("runner", 60, 7));
    expect(run("runner", 60, 7)).not.toEqual(run("runner", 60, 8));
  });

  it("runners stay inside and out of forbidden zones at 2–4 m/s", () => {
    const s = run("runner", 600, 3);
    for (const x of s) {
      expect(pointInRing(ll(x.true), ring)).toBe(true);
      expect(pointInRing(ll(x.true), zone)).toBe(false);
    }
    const speeds = s.map((x) => x.fix!.speed);
    const mean = speeds.reduce((a, b) => a + b, 0) / speeds.length;
    expect(mean).toBeGreaterThan(1.5);
    expect(mean).toBeLessThan(4.5);
  });

  it("wanderer ends > 40 m outside and says so", () => {
    const s = run("wanderer", 120, 2);
    const last = s.at(-1)!;
    expect(signedDistanceToRing(ll(last.true), ring)).toBeGreaterThan(40);
    expect(last.expect).toContain("outside");
  });

  it("forbidden bot ends inside the zone", () => {
    const last = run("forbidden", 90, 4).at(-1)!;
    expect(pointInRing(ll(last.true), zone)).toBe(true);
    expect(last.expect).toContain("forbidden");
  });

  it("dropout loses signal for the configured window", () => {
    const s = run("dropout", 120, 5, { dropoutAfterS: 20, dropoutForS: 60 });
    const lost = s.filter((x) => x.fix === null).length;
    expect(lost).toBe(30); // 60 s / 2 s
    expect(s[5].fix).not.toBeNull();
  });

  it("sos presses exactly once", () => {
    expect(run("sos", 120, 6, { sosAfterS: 30 }).filter((x) => x.sos)).toHaveLength(1);
  });

  it("cheater moves at ~25 km/t, jitter has poor accuracy", () => {
    const c = run("cheater", 60, 7);
    expect(c.slice(1).every((x) => x.fix!.speed > 5)).toBe(true);
    expect(run("jitter", 60, 8).every((x) => x.fix!.acc >= 20)).toBe(true);
  });

  it("hider settles and stands still", () => {
    const s = run("hider", 200, 9);
    expect(haversine(ll(s.at(-1)!.true), ll(s.at(-5)!.true))).toBeLessThan(1);
  });

  it("mixes", () => {
    const m = defaultMix(60);
    expect(m).toHaveLength(60);
    for (const k of ["wanderer", "forbidden", "dropout", "sos", "cheater"]) expect(m).toContain(k);
    expect(parseMix("runner:3,sos:1")).toEqual(["runner", "runner", "runner", "sos"]);
    expect(() => parseMix("dragon:1")).toThrow();
  });
});
