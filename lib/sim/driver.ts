// Bot swarm driver (PLAN §11.2–11.3). Every bot is a real player through the
// public API (join → tick/sos). Runs in the browser (/dev/sim) and headless
// (scripts/sim.mjs, bundled with esbuild). No DOM, no Node-only APIs.
//
// Measures what phase 1 «Ferdig når» asks for:
//   * tick latency (p50/p95/p99),
//   * alarm latency: from the moment a bot is in a reportable state (SOS
//     pressed, inside a forbidden zone, > 40 m outside, 60 s without a fix)
//     until the teacher's snapshot shows that alarm. Needs the host token.

import { createBot, type Behaviour, type Bot, type BotFix, type SimGeo } from "./behaviours";

export type AlarmKind = "sos" | "forbidden" | "outside" | "signal";

export interface Transport {
  post: (path: string, body: unknown) => Promise<{ status: number; data: Record<string, unknown> }>;
  /** Optional override for the hot path (e.g. direct PostgREST RPC in the load test). */
  tick?: (sessionId: string, b: SimPlayer, fix: BotFix) => Promise<{ status: number; data: Record<string, unknown> }>;
}

export interface SimPlayer {
  i: number;
  kind: Behaviour;
  playerId: string;
  token: string;
  nickname: string;
  bot: Bot;
  lastTickAt: number | null;
  lastFix: BotFix | null;
  view: Record<string, unknown> | null;
  /** Conditions the bot was in on its previous step (expectations fire on entry only). */
  prevExpect: Set<string>;
}

export interface AlarmCheck {
  player: string;
  kind: AlarmKind;
  expectedAt: number;
  seenAt: number | null;
}

export interface SimStats {
  startedAt: number;
  ticks: number;
  errors: Record<string, number>;
  latencies: number[];
  alarms: AlarmCheck[];
}

export interface SwarmOptions {
  transport: Transport;
  pin: string;
  kinds: Behaviour[];
  seed: number;
  tickMs?: number;
  hostToken?: string; // enables alarm-latency checks
  sosAfterS?: number;
  dropoutAfterS?: number;
  dropoutForS?: number;
  namePrefix?: string;
  onUpdate?: (players: SimPlayer[], stats: SimStats) => void;
  onLog?: (line: string) => void;
}

const SIGNAL_ALARM_S = 60;

export function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

const KIND_NO: Record<Behaviour, string> = {
  runner: "løper",
  hider: "gjemmer",
  wanderer: "vandrer",
  forbidden: "forbudt",
  dropout: "dropout",
  sos: "sos",
  cheater: "juks",
  jitter: "jitter",
};

/** Start a swarm. Returns a stop() and a promise of the session id once joined. */
export function startSwarm(opts: SwarmOptions) {
  const tickMs = opts.tickMs ?? 2000;
  const log = opts.onLog ?? (() => {});
  const stats: SimStats = { startedAt: Date.now(), ticks: 0, errors: {}, latencies: [], alarms: [] };
  const players: SimPlayer[] = [];
  const timers: ReturnType<typeof setInterval>[] = [];
  let stopped = false;
  let sessionId = "";

  const err = (code: string) => {
    stats.errors[code] = (stats.errors[code] ?? 0) + 1;
  };
  const expect = (player: string, kind: AlarmKind, at: number) => {
    if (!opts.hostToken) return;
    if (stats.alarms.some((a) => a.player === player && a.kind === kind && (a.seenAt === null || a.expectedAt === at))) return;
    stats.alarms.push({ player, kind, expectedAt: at, seenAt: null });
  };

  async function tickOne(p: SimPlayer) {
    const s = p.bot.step(tickMs / 1000);
    const now = Date.now();
    if (s.sos) {
      expect(p.playerId, "sos", now);
      log(`🆘 ${p.nickname} trykker SOS`);
      const r = await opts.transport.post(`/api/s/${sessionId}/sos`, { playerId: p.playerId, token: p.token, lat: s.fix?.lat, lng: s.fix?.lng });
      if (r.status !== 200) err(`sos_${r.status}`);
    }
    for (const k of s.expect) if (!p.prevExpect.has(k)) expect(p.playerId, k, now);
    p.prevExpect = new Set(s.expect);
    if (!s.fix) {
      if (p.lastTickAt) expect(p.playerId, "signal", p.lastTickAt + SIGNAL_ALARM_S * 1000);
      p.lastFix = null;
      return;
    }
    p.lastFix = s.fix;
    const t0 = Date.now();
    const r = opts.transport.tick
      ? await opts.transport.tick(sessionId, p, s.fix)
      : await opts.transport.post(`/api/s/${sessionId}/tick`, {
          playerId: p.playerId,
          token: p.token,
          lat: s.fix.lat,
          lng: s.fix.lng,
          acc: s.fix.acc,
          speed: s.fix.speed,
          ts: Date.now(),
        });
    stats.latencies.push(Date.now() - t0);
    if (stats.latencies.length > 200_000) stats.latencies.splice(0, 100_000);
    if (r.status === 200) {
      stats.ticks++;
      p.lastTickAt = Date.now();
      p.view = r.data;
      // A signal-loss check is satisfied once the bot reports again.
      stats.alarms = stats.alarms.filter((a) => !(a.player === p.playerId && a.kind === "signal" && a.seenAt === null && a.expectedAt > Date.now()));
    } else err(`tick_${r.status}_${String(r.data.error ?? "")}`);
  }

  async function pollHost() {
    if (!opts.hostToken || stopped) return;
    const r = await opts.transport.post(`/api/s/${sessionId}/snapshot`, { hostToken: opts.hostToken });
    if (r.status !== 200) return err(`snapshot_${r.status}`);
    const now = Date.now();
    const alarms = (r.data.alarms as Array<{ player_id: string; kind: AlarmKind; resolved: boolean; created_at: string }>) ?? [];
    for (const c of stats.alarms) {
      if (c.seenAt !== null || c.expectedAt > now + 1000) continue;
      // An old, resolved-but-unacked alarm of the same kind must not count for a new event.
      const hit = alarms.some(
        (a) => a.player_id === c.player && a.kind === c.kind && (!a.resolved || Date.parse(a.created_at) >= c.expectedAt - 5000),
      );
      if (hit) c.seenAt = Math.max(now, c.expectedAt);
    }
  }

  const ready = (async () => {
    log(`Melder inn ${opts.kinds.length} boter …`);
    for (let i = 0; i < opts.kinds.length && !stopped; i++) {
      const kind = opts.kinds[i];
      const nickname = `${opts.namePrefix ?? "Bot"}${String(i + 1).padStart(2, "0")} ${KIND_NO[kind]}`.slice(0, 20);
      const r = await opts.transport.post("/api/join", { pin: opts.pin, nickname });
      if (r.status !== 200) {
        err(`join_${r.status}_${String(r.data.error ?? "")}`);
        continue;
      }
      sessionId = String(r.data.sessionId);
      players.push({
        i,
        kind,
        playerId: String(r.data.playerId),
        token: String(r.data.token),
        nickname,
        bot: null as unknown as Bot,
        lastTickAt: null,
        lastFix: null,
        view: null,
        prevExpect: new Set(),
      });
    }
    if (!players.length) throw new Error("Ingen boter kom inn (feil PIN?)");
    const me = await opts.transport.post(`/api/s/${sessionId}/me`, { playerId: players[0].playerId, token: players[0].token });
    if (me.status !== 200) throw new Error(`me ${me.status}`);
    const geo = me.data.geo as SimGeo;
    for (const p of players) {
      p.bot = createBot(p.kind, geo, {
        seed: opts.seed * 1000 + p.i,
        sosAfterS: opts.sosAfterS,
        dropoutAfterS: opts.dropoutAfterS,
        dropoutForS: opts.dropoutForS,
      });
    }
    log(`${players.length} boter er med. Starter tick hvert ${tickMs / 1000}. sekund.`);
    stats.startedAt = Date.now();
    players.forEach((p, idx) => {
      // Stagger so ticks spread evenly over the interval, like real phones.
      const start = setTimeout(() => {
        if (stopped) return;
        void tickOne(p);
        timers.push(setInterval(() => void tickOne(p), tickMs));
      }, Math.floor((idx * tickMs) / players.length));
      timers.push(start as unknown as ReturnType<typeof setInterval>);
    });
    if (opts.hostToken) timers.push(setInterval(() => void pollHost(), 1000));
    if (opts.onUpdate) timers.push(setInterval(() => opts.onUpdate!(players, stats), 1000));
    return { sessionId, geo };
  })();

  return {
    ready,
    players,
    stats,
    stop() {
      stopped = true;
      for (const t of timers) {
        clearInterval(t);
        clearTimeout(t as unknown as ReturnType<typeof setTimeout>);
      }
    },
  };
}

/** fetch-based transport against a Chase base URL. */
export function httpTransport(base: string): Transport {
  return {
    async post(path, body) {
      try {
        const res = await fetch(base + path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        return { status: res.status, data };
      } catch {
        return { status: 0, data: { error: "network" } };
      }
    },
  };
}

export function summarize(stats: SimStats) {
  const lat = stats.latencies;
  const alarmLat = stats.alarms.filter((a) => a.seenAt !== null).map((a) => (a.seenAt! - a.expectedAt) / 1000);
  return {
    seconds: Math.round((Date.now() - stats.startedAt) / 1000),
    ticks: stats.ticks,
    errors: stats.errors,
    tickMs: { p50: percentile(lat, 50), p95: percentile(lat, 95), p99: percentile(lat, 99), max: lat.length ? Math.max(...lat) : 0 },
    alarms: {
      expected: stats.alarms.length,
      seen: alarmLat.length,
      pending: stats.alarms.filter((a) => a.seenAt === null).map((a) => `${a.kind}@${Math.round((Date.now() - a.expectedAt) / 1000)}s`),
      maxDelayS: alarmLat.length ? Math.max(...alarmLat) : null,
      byKind: Object.fromEntries(
        (["sos", "forbidden", "outside", "signal"] as const).map((k) => {
          const xs = stats.alarms.filter((a) => a.kind === k && a.seenAt !== null).map((a) => (a.seenAt! - a.expectedAt) / 1000);
          return [k, xs.length ? { n: xs.length, maxS: Math.max(...xs) } : null];
        }),
      ),
    },
  };
}
