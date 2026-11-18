import { describe, expect, it } from "vitest";

import { createGpsFilter, GPS_FILTER, type RawFix } from "@/lib/client/gpsFilter";
import { geofenceLevel, inForbidden } from "@/lib/rules/safety";
import { haversine, makeProjection, pointInRing, signedDistanceToRing, type LngLat } from "@/lib/geo";
import { createBot, type Behaviour, type SimGeo } from "@/lib/sim/behaviours";
import { gauss, rng } from "@/lib/sim/rng";

const O: LngLat = [10.75, 59.91];
const proj = makeProjection(O);
const at = (e: number, n: number, t: number, acc = 8, speed: number | null = null): RawFix => {
  const [lng, lat] = proj.toLngLat(e, n);
  return { lat, lng, acc, speed, at: t };
};
const xy = (f: { lat: number; lng: number }) => proj.toXY([f.lng, f.lat]);
const err = (f: { lat: number; lng: number }, e: number, n: number) => {
  const [x, y] = xy(f);
  return Math.hypot(x - e, y - n);
};

describe("gps filter: basics", () => {
  it("passes the first fix through unchanged", () => {
    const f = createGpsFilter();
    const raw = at(5, 5, 1000);
    expect(f.push(raw)).toEqual(raw);
  });

  it("keeps the raw accuracy and speed (the server decides on what was measured)", () => {
    const f = createGpsFilter();
    f.push(at(0, 0, 0, 12, 3));
    const out = f.push(at(4, 1, 1000, 17, 3.3))!;
    expect(out.acc).toBe(17);
    expect(out.speed).toBe(3.3);
    expect(out.at).toBe(1000);
  });

  it("smooths jitter for a pupil standing still", () => {
    const r = rng(11);
    const f = createGpsFilter();
    let rawErr = 0;
    let outErr = 0;
    for (let i = 0; i < 120; i++) {
      const raw = at(gauss(r) * 5, gauss(r) * 5, i * 1000, 10);
      const out = f.push(raw)!;
      if (i < 10) continue;
      rawErr += err(raw, 0, 0) ** 2;
      outErr += err(out, 0, 0) ** 2;
    }
    expect(Math.sqrt(outErr / rawErr)).toBeLessThan(0.7);
  });

  it("tracks a steady runner without lag and with less noise", () => {
    const r = rng(5);
    const f = createGpsFilter();
    let rawErr = 0;
    let outErr = 0;
    let along = 0;
    for (let i = 0; i < 90; i++) {
      const e = i * 4; // 4 m/s east
      const raw = at(e + gauss(r) * 4, gauss(r) * 4, i * 1000, 8);
      const out = f.push(raw)!;
      if (i < 10) continue;
      rawErr += err(raw, e, 0) ** 2;
      outErr += err(out, e, 0) ** 2;
      along += xy(out)[0] - e;
    }
    expect(outErr).toBeLessThan(rawErr);
    expect(Math.abs(along / 80)).toBeLessThan(1); // mean along-track bias under 1 m
  });

  it("never moves a fix further than min(acc, clamp) from the raw one", () => {
    const r = rng(3);
    const f = createGpsFilter();
    for (let i = 0; i < 200; i++) {
      // sharp zig-zags: worst case for a constant-velocity model
      const e = (i % 10 < 5 ? i % 10 : 10 - (i % 10)) * 6;
      const acc = 3 + r() * 20;
      const raw = at(e + gauss(r) * 3, gauss(r) * 3, i * 1000, acc);
      const out = f.push(raw);
      if (!out) continue;
      expect(haversine([out.lng, out.lat], [raw.lng, raw.lat])).toBeLessThanOrEqual(Math.min(acc, GPS_FILTER.clamp_m) + 0.01);
    }
  });
});

describe("gps filter: jumps", () => {
  it("holds back a single wild jump and carries on", () => {
    const f = createGpsFilter();
    f.push(at(0, 0, 0, 6));
    f.push(at(2, 0, 1000, 6));
    expect(f.push(at(120, 0, 2000, 6))).toBeNull(); // 120 m in a second
    const back = f.push(at(5, 0, 3000, 6))!;
    expect(back).not.toBeNull();
    expect(err(back, 5, 0)).toBeLessThan(6);
  });

  it("trusts a new place after max_reject fixes there", () => {
    const f = createGpsFilter();
    f.push(at(0, 0, 0, 6));
    const outs = [1, 2, 3].map((i) => f.push(at(150, 0, i * 1000, 6)));
    expect(outs.slice(0, GPS_FILTER.max_reject)).toEqual([null, null]);
    expect(err(outs[GPS_FILTER.max_reject]!, 150, 0)).toBeLessThan(0.01);
  });

  it("never holds back longer than max_reject_ms", () => {
    const f = createGpsFilter();
    f.push(at(0, 0, 0, 6));
    expect(f.push(at(300, 0, 1000, 6))).toBeNull();
    expect(f.push(at(300, 0, 1000 + GPS_FILTER.max_reject_ms, 6))).not.toBeNull();
  });

  it("does not call a big move a jump when the accuracy explains it", () => {
    const f = createGpsFilter();
    f.push(at(0, 0, 0, 40));
    expect(f.push(at(60, 0, 1000, 40))).not.toBeNull();
  });

  it("starts fresh after a long gap (locked screen)", () => {
    const f = createGpsFilter();
    f.push(at(0, 0, 0, 6));
    const out = f.push(at(400, 0, GPS_FILTER.reset_gap_ms + 1000, 6))!;
    expect(err(out, 400, 0)).toBeLessThan(0.01);
  });
});

// Safety (CLAUDE.md rule 4): bots that leave the area or walk into a forbidden
// zone must raise the same alarm level no later with the filter than without.
const ring: LngLat[] = [[10.75, 59.91], [10.7518, 59.91], [10.7518, 59.9109], [10.75, 59.9109], [10.75, 59.91]];
const zone: LngLat[] = [[10.751, 59.9105], [10.75136, 59.9105], [10.75136, 59.91068], [10.751, 59.91068], [10.751, 59.9105]];
const geo: SimGeo = {
  boundary: { coordinates: [ring as unknown as number[][]] },
  forbidden: { coordinates: [[zone as unknown as number[][]]] },
  assembly: { lat: 59.91045, lng: 10.7509 },
};

/** Seconds from the bot truly being in alarm state (sim `expect`) until the server
 * would see it (geofence level >= 3 / forbidden), plus alarm seconds before that
 * (false alarms from noise). Same maths as tick() via the TS twins. */
function onsets(kind: Behaviour, seed: number, filtered: boolean) {
  const bot = createBot(kind, geo, { seed });
  const f = createGpsFilter();
  const truthKey = kind === "wanderer" ? "outside" : "forbidden";
  let last: { lat: number; lng: number; acc: number } | null = null;
  let outsideSince: number | null = null;
  let truthAt: number | null = null;
  let seenAt: number | null = null;
  let falseS = 0;
  for (let t = 1; t <= 240; t++) {
    const s = bot.step(1);
    if (s.expect.includes(truthKey)) truthAt ??= t;
    if (s.fix) {
      const raw = { ...s.fix, at: t * 1000 };
      const out = filtered ? f.push(raw) : raw;
      if (out) last = out;
    }
    if (!last) continue;
    const p: LngLat = [last.lng, last.lat];
    const d = signedDistanceToRing(p, ring);
    const inside = pointInRing(p, ring);
    if (!inside && d > last.acc) outsideSince ??= t;
    else outsideSince = null;
    const alarm =
      truthKey === "outside"
        ? geofenceLevel({
            inside,
            edgeDistanceM: Math.abs(d),
            outsideM: Math.max(0, d),
            accM: last.acc,
            outsideForS: outsideSince === null ? 0 : t - outsideSince,
          }) >= 3
        : pointInRing(p, zone) || inForbidden(Math.max(0, signedDistanceToRing(p, zone)), last.acc);
    if (!alarm) continue;
    if (truthAt === null) falseS++;
    else seenAt ??= t;
  }
  return { delay: truthAt !== null && seenAt !== null ? seenAt - truthAt : null, falseS };
}

describe("gps filter: safety alarms are not delayed", () => {
  it("outside alarm (wanderer) and forbidden alarm (forbidden) over 40 seeds", () => {
    const extra: number[] = [];
    let falseRaw = 0;
    let falseFil = 0;
    for (let seed = 1; seed <= 40; seed++) {
      for (const kind of ["wanderer", "forbidden"] as const) {
        const raw = onsets(kind, seed, false);
        const fil = onsets(kind, seed, true);
        expect(raw.delay).not.toBeNull();
        expect(fil.delay).not.toBeNull();
        extra.push(fil.delay! - raw.delay!);
        falseRaw += raw.falseS;
        falseFil += fil.falseS;
      }
    }
    // Ticks go out every ~2 s; a one-second shift is inside one tick.
    expect(Math.max(...extra)).toBeLessThanOrEqual(1);
    expect(extra.reduce((a, b) => a + b, 0) / extra.length).toBeLessThanOrEqual(0.25);
    expect(falseFil).toBeLessThanOrEqual(falseRaw);
  });
});

describe("gps filter: glitches", () => {
  it("removes false outside alarms from single multipath spikes", () => {
    let rawAlarms = 0;
    let filAlarms = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const bot = createBot("runner", geo, { seed });
      const r = rng(seed + 100);
      const f = createGpsFilter();
      let lastRaw: LngLat | null = null;
      let lastFil: LngLat | null = null;
      for (let t = 1; t <= 300; t++) {
        const s = bot.step(1);
        if (!s.fix) continue;
        let fix = { ...s.fix, at: t * 1000 };
        if (t % 23 === 0) {
          // one fix thrown 60–120 m away in a random direction, with a confident accuracy
          const [x, y] = proj.toXY([fix.lng, fix.lat]);
          const a = r() * Math.PI * 2;
          const d = 60 + r() * 60;
          const [lng, lat] = proj.toLngLat(x + Math.cos(a) * d, y + Math.sin(a) * d);
          fix = { ...fix, lat, lng, acc: 6 };
        }
        lastRaw = [fix.lng, fix.lat];
        const out = f.push(fix);
        if (out) lastFil = [out.lng, out.lat];
        if (signedDistanceToRing(lastRaw, ring) > 40) rawAlarms++;
        if (lastFil && signedDistanceToRing(lastFil, ring) > 40) filAlarms++;
      }
    }
    expect(rawAlarms).toBeGreaterThan(5);
    expect(filAlarms).toBe(0);
  });
});
