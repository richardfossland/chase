// Bot behaviours for the GPS simulator (PLAN §11.2). Pure and seeded: the same
// seed + geometry + step sequence gives the same positions, so scenarios are
// reproducible in the browser swarm, the headless load test and unit tests.
//
// Bots move in a local metric plane (x east, y north) around the area centre
// and report WGS84 fixes with simulated accuracy and noise.

import { makeProjection, pointInRing, ringCenter, signedDistanceToRing, type LngLat } from "@/lib/geo";

import { zoneAt, type ZoneState } from "@/lib/rules/zone";

import { gauss, rng } from "./rng";

export const BEHAVIOURS = ["runner", "hider", "wanderer", "forbidden", "dropout", "sos", "cheater", "jitter"] as const;
export type Behaviour = (typeof BEHAVIOURS)[number];

export interface SimGeo {
  boundary: { coordinates: number[][][] };
  forbidden: { coordinates: number[][][][] } | null;
  assembly: { lat: number; lng: number };
}

export interface BotFix {
  lat: number;
  lng: number;
  acc: number;
  speed: number;
}

export interface BotStep {
  fix: BotFix | null; // null = no signal
  sos: boolean; // press the SOS button this step
  /** What a teacher should be alerted about from now on (for latency checks). */
  expect: Array<"forbidden" | "outside">;
}

/** What a bot learns from its last tick response (phase 2): posts to run to, game phase. */
export interface BotView {
  status?: string;
  role?: string;
  tag?: { radar?: { pos: { lat: number; lng: number } }[]; hunter_near?: boolean } | null;
  posts?: { pos: { lat: number; lng: number } }[] | null;
  gather?: { checked_in: boolean } | null;
  round?: { zone?: ZoneState | null } | null;
  zone?: { inside: boolean } | null;
}

export interface BotOptions {
  seed: number;
  sosAfterS?: number; // `sos` bot
  dropoutAfterS?: number; // `dropout` bot
  dropoutForS?: number;
}

type XY = [number, number];

export function createBot(kind: Behaviour, geo: SimGeo, opts: BotOptions) {
  const r = rng(opts.seed);
  const ring = geo.boundary.coordinates[0] as unknown as LngLat[];
  const centre = ringCenter(ring);
  const proj = makeProjection(centre);
  const zones = (geo.forbidden?.coordinates ?? []).map((p) => p[0] as unknown as LngLat[]);
  const inside = (p: XY) => pointInRing(proj.toLngLat(p[0], p[1]), ring);
  const inZone = (p: XY) => zones.some((z) => pointInRing(proj.toLngLat(p[0], p[1]), z));
  const safe = (p: XY) => inside(p) && !zones.some((z) => signedDistanceToRing(proj.toLngLat(p[0], p[1]), z) < 8);

  // Start somewhere safe near the assembly point (pupils join there).
  const a = proj.toXY([geo.assembly.lng, geo.assembly.lat]);
  let pos: XY = [a[0], a[1]];
  for (let i = 0; i < 50; i++) {
    const cand: XY = [a[0] + gauss(r) * 12, a[1] + gauss(r) * 12];
    if (safe(cand)) {
      pos = cand;
      break;
    }
  }

  let heading = r() * Math.PI * 2;
  let view: BotView = {};
  let t = 0;
  let sosSent = false;
  const baseSpeed = kind === "cheater" ? 7 + r() : kind === "runner" || kind === "dropout" || kind === "sos" ? 2 + r() * 2 : 1.3;
  const baseAcc = kind === "jitter" ? 30 + r() * 30 : 4 + r() * 6;
  const sosAt = opts.sosAfterS ?? 30 + r() * 60;
  const dropAt = opts.dropoutAfterS ?? 20 + r() * 20;
  const dropFor = opts.dropoutForS ?? 90;

  // Targets for goal-seeking behaviours.
  const hideSpot: XY = (() => {
    const v = proj.toXY(ring[Math.floor(r() * (ring.length - 1))]);
    return [v[0] * 0.8, v[1] * 0.8]; // inset towards the centre
  })();
  const zoneTarget: XY | null = zones.length ? (proj.toXY(ringCenter(zones[0])) as XY) : null;
  const outward: XY = (() => {
    const d = Math.hypot(pos[0], pos[1]) || 1;
    return [pos[0] / d, pos[1] / d];
  })();

  function wander(dt: number, speed: number, keepSafe: boolean) {
    heading += gauss(r) * 0.5;
    for (let tries = 0; tries < 12; tries++) {
      const next: XY = [pos[0] + Math.cos(heading) * speed * dt, pos[1] + Math.sin(heading) * speed * dt];
      if (!keepSafe || safe(next)) {
        pos = next;
        return;
      }
      heading += Math.PI / 2 + r() * Math.PI; // bounce
    }
  }

  function seek(target: XY, dt: number, speed: number) {
    const dx = target[0] - pos[0];
    const dy = target[1] - pos[1];
    const d = Math.hypot(dx, dy);
    if (d < 1) return;
    const s = Math.min(d, speed * dt);
    pos = [pos[0] + (dx / d) * s, pos[1] + (dy / d) * s];
  }

  // Postjakt: runners (and hiders, slowly) go for the nearest open post.
  function nearestPostXY(): XY | null {
    let best: XY | null = null;
    let bestD = Infinity;
    for (const p of view.posts ?? []) {
      const xy = proj.toXY([p.pos.lng, p.pos.lat]) as XY;
      const d = Math.hypot(xy[0] - pos[0], xy[1] - pos[1]);
      if (d < bestD) {
        bestD = d;
        best = xy;
      }
    }
    return best;
  }

  // Zone target: the centre, while further out than 80 % of the (next) radius.
  function zoneSeek(): XY | null {
    const z = view.round?.zone;
    if (!z) return null;
    const zn = zoneAt(z, Date.now());
    const r = zn.warn && zn.next ? zn.next.r : zn.r;
    const c = proj.toXY([z.c.lng, z.c.lat]) as XY;
    return Math.hypot(c[0] - pos[0], c[1] - pos[1]) > r * 0.8 ? c : null;
  }

  function step(dt: number): BotStep {
    t += dt;
    const before: XY = [pos[0], pos[1]];
    let sos = false;
    let signal = true;
    const special = kind === "wanderer" || kind === "forbidden" || kind === "cheater" || kind === "sos";

    // Shared phase behaviour for ordinary bots: walk to the assembly point when
    // gathering, stroll in the breather, chase posts in a Postjakt round.
    if (!special && view.status === "gathering") {
      if (!view.gather?.checked_in) seek(a as XY, dt, 1.4);
    } else if (!special && view.status === "breather") {
      wander(dt, 0.5, true);
    } else if (!special && kind !== "hider" && view.status === "live" && zoneSeek()) {
      // Krympende sone: get inside the circle (the next one once it is announced). Hiders don't bother.
      seek(zoneSeek()!, dt, baseSpeed + 0.5);
    } else if (!special && view.status === "live" && view.role === "hunter" && view.tag?.radar?.length) {
      // Smittejakt hunter: run to the freshest radar ping.
      const ping = view.tag.radar[0].pos;
      seek(proj.toXY([ping.lng, ping.lat]) as XY, dt, baseSpeed + 0.5);
    } else if (!special && view.status === "live" && view.role === "prey" && view.tag?.hunter_near) {
      wander(dt, baseSpeed + 1, true);   // prey: sprint somewhere when the ring pulses
    } else if ((kind === "runner" || kind === "hider") && view.status === "live" && nearestPostXY()) {
      seek(nearestPostXY()!, dt, kind === "hider" ? 1.5 : baseSpeed);
    } else switch (kind) {
      case "runner":
      case "cheater":
        wander(dt, baseSpeed, true);
        break;
      case "hider":
        seek(hideSpot, dt, 1.5);
        break;
      case "wanderer":
        if (t < 20) wander(dt, baseSpeed, true);
        else if (signedDistanceToRing(proj.toLngLat(pos[0], pos[1]), ring) < 60) {
          pos = [pos[0] + outward[0] * 1.5 * dt, pos[1] + outward[1] * 1.5 * dt];
        }
        break;
      case "forbidden":
        if (zoneTarget && t > 10) seek(zoneTarget, dt, 1.8);
        else wander(dt, baseSpeed, true);
        break;
      case "dropout":
        wander(dt, baseSpeed, true);
        signal = !(t >= dropAt && t < dropAt + dropFor);
        break;
      case "sos":
        if (t < sosAt) wander(dt, baseSpeed, true);
        if (!sosSent && t >= sosAt) {
          sos = true;
          sosSent = true;
        }
        break;
      case "jitter":
        wander(dt, 0.8, true);
        break;
    }

    const speed = Math.hypot(pos[0] - before[0], pos[1] - before[1]) / Math.max(dt, 0.001);
    const acc = Math.max(3, baseAcc + gauss(r) * 2);
    const noise = kind === "jitter" ? acc * 0.6 : acc * 0.15;
    const reported: XY = [pos[0] + gauss(r) * noise, pos[1] + gauss(r) * noise];
    const ll = proj.toLngLat(reported[0], reported[1]);

    const expect: BotStep["expect"] = [];
    if (inZone(pos)) expect.push("forbidden");
    if (signedDistanceToRing(proj.toLngLat(pos[0], pos[1]), ring) > 40) expect.push("outside");

    return {
      fix: signal ? { lat: ll[1], lng: ll[0], acc: Math.round(acc * 10) / 10, speed: Math.round(speed * 100) / 100 } : null,
      sos,
      expect,
    };
  }

  return {
    kind,
    step,
    observe: (v: BotView) => {
      view = v;
    },
    /** True local position (for the sim map), not the noisy reported one. */
    truePos: () => {
      const ll = proj.toLngLat(pos[0], pos[1]);
      return { lat: ll[1], lng: ll[0] };
    },
  };
}

export type Bot = ReturnType<typeof createBot>;

/** Default mix for N bots: one of each special behaviour, the rest runners/hiders/jitter. */
export function defaultMix(n: number): Behaviour[] {
  const specials: Behaviour[] = ["wanderer", "forbidden", "dropout", "sos", "cheater"];
  const out: Behaviour[] = [];
  for (let i = 0; i < n; i++) {
    if (i < specials.length && n >= 8) out.push(specials[i]);
    else out.push(i % 10 === 7 ? "hider" : i % 10 === 9 ? "jitter" : "runner");
  }
  return out;
}

/** Parse "runner:40,hider:5,sos:1" into a list of behaviours. */
export function parseMix(spec: string): Behaviour[] {
  const out: Behaviour[] = [];
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [k, n] = part.split(":");
    if (!(BEHAVIOURS as readonly string[]).includes(k)) throw new Error(`unknown behaviour ${k}`);
    for (let i = 0; i < Number(n ?? 1); i++) out.push(k as Behaviour);
  }
  return out;
}
