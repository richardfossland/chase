// Client-side GPS cleanup before a fix is shown or sent (PLAN fase 9, punkt 1).
//
// Two jobs, both pure and deterministic so the simulator and tests can run them:
//   1. Drop single wild jumps (multipath, a stale cached fix): a fix that would
//      need more than `max_jump_mps` beyond both accuracy circles is held back,
//      at most `max_reject` times in a row and never longer than `max_reject_ms`.
//      Until then the last good fix keeps being re-sent (useLiveTick re-sends
//      fixes up to 15 s old), so no signal-loss alarm can come from this.
//   2. Smooth jitter with a constant-velocity Kalman filter per axis. A runner
//      moving steadily is tracked without lag; the output is clamped to stay
//      within min(acc, clamp_m) of the raw fix, i.e. inside the uncertainty the
//      server already allows for (geofence and claims widen by acc).
//
// Safety (CLAUDE.md rule 4): the reported `acc` and `speed` are always the raw
// values — the server keeps deciding on what the phone actually measured — and
// the clamp bounds how far a geofence decision can move. test/gps-filter.test.ts
// checks that alarm onset is not delayed for bots that leave the area.

export const GPS_FILTER = {
  max_jump_mps: 12, // faster than any pupil, with both accuracy circles as slack
  max_reject: 2, // consecutive held-back fixes before we trust the new place
  max_reject_ms: 4000,
  reset_gap_ms: 10_000, // a longer gap (locked screen): start fresh
  accel_mps2: 4, // process noise: how hard a pupil can change speed/direction
  clamp_m: 8, // smoothed point stays within min(acc, clamp_m) of the raw fix
  min_acc_m: 2,
} as const;

export interface RawFix {
  lat: number;
  lng: number;
  acc: number;
  speed: number | null;
  at: number; // ms
}

interface Axis {
  p: number; // position (m)
  v: number; // velocity (m/s)
  pp: number; // covariance
  pv: number;
  vv: number;
}

const M_PER_DEG = (Math.PI / 180) * 6_371_008.8;

export interface GpsFilter {
  /** Feed a raw fix. Returns the fix to use, or null when it is held back as a jump. */
  push<F extends RawFix>(raw: F): F | null;
  reset(): void;
}

export function createGpsFilter(cfg: typeof GPS_FILTER = GPS_FILTER): GpsFilter {
  let origin: { lat: number; lng: number; kx: number } | null = null;
  let x: Axis | null = null;
  let y: Axis | null = null;
  let last: { e: number; n: number; acc: number; at: number } | null = null;
  let rejected = 0;
  let firstRejectAt = 0;

  const toEN = (f: RawFix): [number, number] => {
    if (!origin) origin = { lat: f.lat, lng: f.lng, kx: M_PER_DEG * Math.cos((f.lat * Math.PI) / 180) };
    return [(f.lng - origin.lng) * origin.kx, (f.lat - origin.lat) * M_PER_DEG];
  };
  const fromEN = (e: number, n: number) => ({ lat: origin!.lat + n / M_PER_DEG, lng: origin!.lng + e / origin!.kx });

  const start = (e: number, n: number, acc: number): void => {
    const r = acc * acc;
    x = { p: e, v: 0, pp: r, pv: 0, vv: 25 };
    y = { p: n, v: 0, pp: r, pv: 0, vv: 25 };
  };

  const step = (a: Axis, z: number, dt: number, r: number): void => {
    // predict (constant velocity, white-noise acceleration)
    const q = cfg.accel_mps2 * cfg.accel_mps2;
    a.p += a.v * dt;
    const pp = a.pp + 2 * dt * a.pv + dt * dt * a.vv + (q * dt ** 4) / 4;
    const pv = a.pv + dt * a.vv + (q * dt ** 3) / 2;
    const vv = a.vv + q * dt * dt;
    // update with a position measurement
    const s = pp + r;
    const kp = pp / s;
    const kv = pv / s;
    const innov = z - a.p;
    a.p += kp * innov;
    a.v += kv * innov;
    a.pp = (1 - kp) * pp;
    a.pv = (1 - kp) * pv;
    a.vv = vv - kv * pv;
  };

  const reset = () => {
    origin = null;
    x = y = null;
    last = null;
    rejected = 0;
  };

  function push<F extends RawFix>(raw: F): F | null {
    const acc = Math.max(cfg.min_acc_m, raw.acc);
    if (last && raw.at - last.at > cfg.reset_gap_ms) reset();
    const [e, n] = toEN(raw);

    if (!last || !x || !y) {
      start(e, n, acc);
      last = { e, n, acc, at: raw.at };
      return raw;
    }

    const dt = Math.max(0.05, (raw.at - last.at) / 1000);
    const dist = Math.hypot(e - last.e, n - last.n);
    const jump = Math.max(0, dist - acc - last.acc) / dt > cfg.max_jump_mps;
    if (jump) {
      if (rejected === 0) firstRejectAt = raw.at;
      if (rejected < cfg.max_reject && raw.at - firstRejectAt < cfg.max_reject_ms) {
        rejected++;
        return null;
      }
      // The new place keeps showing up: trust it and start over there.
      rejected = 0;
      start(e, n, acc);
      last = { e, n, acc, at: raw.at };
      return raw;
    }
    rejected = 0;

    const r = acc * acc;
    step(x, e, dt, r);
    step(y, n, dt, r);

    // Clamp to the raw fix's own uncertainty.
    let fe = x.p;
    let fn = y.p;
    const off = Math.hypot(fe - e, fn - n);
    const lim = Math.min(acc, cfg.clamp_m);
    if (off > lim) {
      fe = e + ((fe - e) * lim) / off;
      fn = n + ((fn - n) * lim) / off;
      x.p = fe;
      y.p = fn;
    }

    last = { e: fe, n: fn, acc, at: raw.at };
    const ll = fromEN(fe, fn);
    return { ...raw, lat: ll.lat, lng: ll.lng };
  }

  return { push, reset };
}
