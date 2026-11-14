// Bot swarm driver (PLAN §11.2–11.3). Every bot is a real player through the
// public API (join → tick/sos). Runs in the browser (/dev/sim) and headless
// (scripts/sim.mjs, bundled with esbuild). No DOM, no Node-only APIs.
//
// Measures what phase 1 «Ferdig når» asks for:
//   * tick latency (p50/p95/p99),
//   * alarm latency: from the moment a bot is in a reportable state (SOS
//     pressed, inside a forbidden zone, > 40 m outside, 60 s without a fix)
//     until the teacher's snapshot shows that alarm. Needs the host token.

import { relayBatons } from "@/lib/rules/relay";
import { powerupCheck } from "@/lib/rules/events";

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
  /** Phase 2 game accounting. */
  game: {
    claims: number;
    golden: number;
    lost: number;
    qr: number;
    duplicateClaims: number;
    claimedIds: Set<string>;
    statuses: string[];          // teacher-side status sequence (deduplicated)
    playlistDone: boolean;
    rounds: number;
    catches: number;
    catchFails: Record<string, number>;
    /** Krympende sone: phase bonuses earned and points lost outside (sums over bots). */
    zoneHits: number;
    zonePen: number;
    /** Ceremony (0006): bots that saw their «ditt beste»-kort, and their «vil spille igjen» votes. */
    bestCards: number;
    votes: number;
    /** Phase 4 (0007): events seen by the teacher (per kind), prizes, power-ups, missions. */
    events: Record<string, number>;
    eventKeys: Set<string>;
    sprintMax: number;
    prizes: number;
    powerupsGot: number;
    powerupsUsed: number;
    powerupFails: Record<string, number>;
    missionsDone: number;
    missionsConfirmed: number;
    /** Phase 5 (0009): team sizes when first dealt, final team points, flags taken, hill holds, quick messages. */
    teamSizes: number[] | null;
    teamPoints: Record<string, number>;
    flagCaptures: number;
    hillHolds: number;
    /** 0013: relay legs (all teams, from the course), batons held at once on one team vs. the cap. */
    relayLegs: number;
    relayBatonMax: number;
    relayBatonCap: number;
    capKeys: Set<string>;
    relayLegsByRound: Map<number, number>;
    msgsSent: number;
    msgsSeen: number;
    msgKeys: Set<string>;
    /** Phase 7 (0012): questions answered (right) and steps sent. */
    quizAnswered: number;
    quizRight: number;
    steps: number;
  };
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
  const stats: SimStats = {
    startedAt: Date.now(),
    ticks: 0,
    errors: {},
    latencies: [],
    alarms: [],
    game: { claims: 0, golden: 0, lost: 0, qr: 0, duplicateClaims: 0, claimedIds: new Set(), statuses: [], playlistDone: false, rounds: 0, catches: 0, catchFails: {}, zoneHits: 0, zonePen: 0, bestCards: 0, votes: 0,
      events: {}, eventKeys: new Set(), sprintMax: 0, prizes: 0, powerupsGot: 0, powerupsUsed: 0, powerupFails: {}, missionsDone: 0, missionsConfirmed: 0,
      teamSizes: null, teamPoints: {}, flagCaptures: 0, hillHolds: 0, relayLegs: 0, relayBatonMax: 0, relayBatonCap: 0, relayLegsByRound: new Map(), capKeys: new Set(), msgsSent: 0, msgsSeen: 0, msgKeys: new Set(), quizAnswered: 0, quizRight: 0, steps: 0 },
  };
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
          // 0012: a moving bot reports ~2 steps per second it moved.
          steps: s.fix.speed > 0.5 ? Math.round(s.fix.speed * (tickMs / 1000) * 1.3) : undefined,
        });
    stats.latencies.push(Date.now() - t0);
    if (stats.latencies.length > 200_000) stats.latencies.splice(0, 100_000);
    if (r.status === 200) {
      stats.ticks++;
      p.lastTickAt = Date.now();
      const z0 = (p.view as { zone?: { hits: number; pen: number } } | null)?.zone;
      const z1 = (r.data as { zone?: { hits: number; pen: number } }).zone;
      if (z1) {
        // Per-round counters: a drop means a new round started.
        stats.game.zoneHits += z0 && z1.hits >= z0.hits ? z1.hits - z0.hits : z1.hits;
        stats.game.zonePen += z0 && z1.pen >= z0.pen ? z1.pen - z0.pen : z1.pen;
      }
      const prevView = p.view;
      p.view = r.data;
      const cer = (r.data as { ceremony?: { best: unknown; voted: boolean | null } }).ceremony;
      if (cer?.best && !voted.has(p.playerId)) {
        voted.add(p.playerId);
        stats.game.bestCards++;
        const v = await opts.transport.post(`/api/s/${sessionId}/again`, { playerId: p.playerId, token: p.token, yes: p.nickname.length % 3 !== 0 });
        if (v.status === 200) stats.game.votes++;
        else err(`again_${v.status}`);
      }
      p.bot.observe(r.data as never);
      const claimed = r.data.claimed as { post_id: string; kind: string } | null | undefined;
      if (claimed) {
        stats.game.claims++;
        if (claimed.kind === "golden") stats.game.golden++;
        if (stats.game.claimedIds.has(claimed.post_id)) stats.game.duplicateClaims++;
        stats.game.claimedIds.add(claimed.post_id);
      }
      if (r.data.lost) stats.game.lost++;
      void tryCatch(p);
      void tryEvent(p, prevView);
      void tryTeam(p);
      void tryQuiz(p);
      if (s.fix.speed > 0.5) stats.game.steps += Math.round(s.fix.speed * (tickMs / 1000) * 1.3);
      // A signal-loss check is satisfied once the bot reports again.
      stats.alarms = stats.alarms.filter((a) => !(a.player === p.playerId && a.kind === "signal" && a.seenAt === null && a.expectedAt > Date.now()));
    } else err(`tick_${r.status}_${String(r.data.error ?? "")}`);
  }

  // Smittejakt: a hunter bot that the server says is near prey looks for a prey
  // bot within 12 m (true positions, the "touch") and scans its code.
  const lastTry = new Map<string, number>();
  const voted = new Set<string>();
  async function tryCatch(h: SimPlayer) {
    const v = h.view as { status?: string; role?: string; tag?: { prey_near?: number } } | null;
    if (!v || v.status !== "live" || v.role !== "hunter" || !v.tag?.prey_near) return;
    if (Date.now() - (lastTry.get(h.playerId) ?? 0) < 4000) return;
    const hp = h.bot.truePos();
    const target = players.find((q) => {
      const qv = q.view as { role?: string; tag?: { code?: string | null; immune_until?: string | null } } | null;
      if (!qv || qv.role !== "prey" || !qv.tag?.code || q === h) return false;
      const qp = q.bot.truePos();
      const dy = (qp.lat - hp.lat) * 111_320;
      const dx = (qp.lng - hp.lng) * 111_320 * Math.cos((hp.lat * Math.PI) / 180);
      return Math.hypot(dx, dy) < 12;
    });
    if (!target) return;
    lastTry.set(h.playerId, Date.now());
    const code = (target.view as { tag: { code: string } }).tag.code;
    const r = await opts.transport.post(`/api/s/${sessionId}/catch`, { playerId: h.playerId, token: h.token, code });
    if (r.status === 200) {
      stats.game.catches++;
      log(`🦠 ${h.nickname} fanget ${target.nickname}`);
    } else {
      const k = String(r.data.error ?? r.status);
      stats.game.catchFails[k] = (stats.game.catchFails[k] ?? 0) + 1;
    }
  }

  // Events (0007): count prizes, press «Ferdig» on a mission, use power-ups now and then.
  const missionSent = new Set<string>();
  const lastPu = new Map<string, number>();
  type EvV = { no: number; kind: string; done: boolean; me: { state: string; powerup: string | null } | null } | null | undefined;
  async function tryEvent(p: SimPlayer, before: Record<string, unknown> | null) {
    const v = p.view as { status?: string; role?: string; round?: { idx: number; mode: string } | null; event?: EvV; power?: { inv: string[] } } | null;
    if (!v) return;
    const ev = v.event;
    const pev = (before as { event?: EvV } | null)?.event;
    if (ev?.me && ev.me.state !== "pending" && !(pev?.no === ev.no && pev.me?.state === ev.me.state)) {
      stats.game.prizes++;
      if (ev.me.powerup) stats.game.powerupsGot++;
    }
    if (v.status !== "live") return;
    const key = `${p.playerId}:${v.round?.idx}:${ev?.no}`;
    if (ev && ev.kind === "mission" && !ev.done && !ev.me && !missionSent.has(key) && p.kind !== "hider") {
      missionSent.add(key);
      const r = await opts.transport.post(`/api/s/${sessionId}/event`, { playerId: p.playerId, token: p.token, action: "mission" });
      if (r.status === 200) stats.game.missionsDone++;
      else err(`mission_${r.status}_${String(r.data.error ?? "")}`);
    }
    const inv = v.power?.inv ?? [];
    if (!inv.length || Date.now() - (lastPu.get(p.playerId) ?? 0) < 8000) return;
    const kind = inv.find((k) => powerupCheck(k, v.round?.mode as never, v.role ?? "neutral") === null);
    if (!kind) return;
    lastPu.set(p.playerId, Date.now());
    const r = await opts.transport.post(`/api/s/${sessionId}/event`, { playerId: p.playerId, token: p.token, action: "powerup", kind });
    if (r.status === 200) {
      stats.game.powerupsUsed++;
      log(`✨ ${p.nickname} brukte ${kind}`);
    } else {
      const k = String(r.data.error ?? r.status);
      stats.game.powerupFails[k] = (stats.game.powerupFails[k] ?? 0) + 1;
    }
  }

  // Teams (0009): now and then a quick message; count teammates' messages seen.
  const lastMsg = new Map<string, number>();
  async function tryTeam(p: SimPlayer) {
    const v = p.view as { status?: string; round?: { team?: boolean } | null; team?: { msgs?: { nickname: string; at: string; me: boolean }[] } } | null;
    for (const m of v?.team?.msgs ?? []) {
      const k = `${p.playerId}|${m.nickname}|${m.at}`;
      if (m.me || stats.game.msgKeys.has(k)) continue;
      stats.game.msgKeys.add(k);
      stats.game.msgsSeen++;
    }
    if (v?.status !== "live" || !v.round?.team || p.kind === "hider") return;
    if (Date.now() - (lastMsg.get(p.playerId) ?? 0) < 45_000 || Math.random() > 0.05) return;
    lastMsg.set(p.playerId, Date.now());
    const kinds = ["come", "mine", "help", "ok"];
    const r = await opts.transport.post(`/api/s/${sessionId}/event`, { playerId: p.playerId, token: p.token, action: "team_msg", kind: kinds[p.i % 4] });
    if (r.status === 200) stats.game.msgsSent++;
    else err(`team_msg_${r.status}_${String(r.data.error ?? "")}`);
  }

  // Questions (0012): answer each open question once, a random choice after a moment.
  const answered = new Set<string>();
  async function tryQuiz(p: SimPlayer) {
    const v = p.view as { quiz?: { no: number; a: string[] } } | null;
    const q = v?.quiz;
    if (!q || answered.has(`${p.playerId}:${q.no}`)) return;
    answered.add(`${p.playerId}:${q.no}`);
    const r = await opts.transport.post(`/api/s/${sessionId}/event`, { playerId: p.playerId, token: p.token, action: "quiz", choice: (p.i + q.no) % q.a.length });
    if (r.status === 200) {
      stats.game.quizAnswered++;
      if (r.data.right) stats.game.quizRight++;
    } else err(`quiz_${r.status}_${String(r.data.error ?? "")}`);
  }

  async function pollHost() {
    if (!opts.hostToken || stopped) return;
    const r = await opts.transport.post(`/api/s/${sessionId}/snapshot`, { hostToken: opts.hostToken });
    if (r.status !== 200) return err(`snapshot_${r.status}`);
    const now = Date.now();
    const st = String(r.data.status);
    const g = stats.game;
    const prevSt = g.statuses[g.statuses.length - 1];
    if (prevSt !== st) g.statuses.push(st);
    // Signal loss is only judged in a live round, and the clock restarts at every
    // round start (locked phones in the breather send nothing, CLAUDE.md rule 9).
    // Mirror that: a pending signal check moves to liveStart + 60 s, and one that
    // was not due before the round ended is dropped.
    if (prevSt !== st) {
      for (const c of stats.alarms) {
        if (c.kind !== "signal" || c.seenAt !== null) continue;
        if (st === "live") c.expectedAt = Math.max(c.expectedAt, now + SIGNAL_ALARM_S * 1000);
        else if (prevSt === "live" && c.expectedAt > now) c.expectedAt = Infinity;
      }
      stats.alarms = stats.alarms.filter((c) => c.expectedAt !== Infinity);
    }
    g.playlistDone ||= r.data.playlist_done === true;   // sticky: the ceremony follows
    // Events (0007): count each one once, check the sprint cap, confirm missions like a teacher would.
    const ev = r.data.event as { no: number; kind: string; entries: { state: string }[] } | null;
    const ridx = (r.data.round as { idx: number } | null)?.idx ?? -1;
    if (ev) {
      const key = `${ridx}:${ev.no}`;
      if (!g.eventKeys.has(key)) {
        g.eventKeys.add(key);
        g.events[ev.kind] = (g.events[ev.kind] ?? 0) + 1;
        log(`⚡ hendelse: ${ev.kind}`);
      }
      if (ev.kind === "sprint") g.sprintMax = Math.max(g.sprintMax, ev.entries.filter((x) => x.state === "won").length);
    }
    const pending = (r.data.mission_pending as unknown[] | undefined) ?? [];
    if (pending.length) {
      const c = await opts.transport.post(`/api/s/${sessionId}/host`, { hostToken: opts.hostToken, action: "mission_confirm", payload: {} });
      if (c.status === 200) g.missionsConfirmed += Number(c.data.confirmed ?? 0);
    }
    const round = r.data.round as { idx: number; team?: boolean; flags?: { n: number; owner: number | null }[] | null; hill?: { no: number; holder: number | null } | null;
      relay?: { legs: Record<string, number> } | null } | null;
    if (round?.relay) {
      const prev = g.relayLegsByRound.get(round.idx) ?? 0;
      const sum = Object.values(round.relay.legs).reduce((a, b) => a + b, 0);
      if (sum > prev) {
        g.relayLegs += sum - prev;
        g.relayLegsByRound.set(round.idx, sum);
        log(`🎽 etapper: ${JSON.stringify(round.relay.legs)}`);
      }
      // Batons held at once per team (from the bots' own views) vs. ceil(members / 5).
      const held = new Map<number, number>();
      for (const q of players) {
        const qv = q.view as { team?: { n: number }; relay?: { post: number | null } } | null;
        if (qv?.team && qv.relay?.post !== null && qv.relay?.post !== undefined) held.set(qv.team.n, (held.get(qv.team.n) ?? 0) + 1);
      }
      const tms = (r.data.teams as { n: number; members: number }[] | undefined) ?? [];
      for (const [n, k] of held) {
        const cap = relayBatons(tms.find((t) => t.n === n)?.members ?? 0);
        g.relayBatonCap = Math.max(g.relayBatonCap, cap);
        if (k > cap) g.relayBatonMax = Math.max(g.relayBatonMax, k);
      }
    }
    if (round) g.rounds = Math.max(g.rounds, round.idx + 1);
    // Teams (0009): sizes at the first team round, live points, captures and hill holds.
    const teams = (r.data.teams as { n: number; name: string; points: number; members: number }[] | undefined) ?? [];
    if (teams.length) {
      if (!g.teamSizes && round?.team && st === "live") {
        g.teamSizes = teams.map((t) => t.members);
        log(`👥 lag: ${teams.map((t) => `${t.name} ${t.members}`).join(" · ")}`);
      }
      for (const t of teams) g.teamPoints[t.name] = t.points;
    }
    for (const f of round?.flags ?? []) {
      const k = `f:${round!.idx}:${f.n}:${f.owner}`;
      if (f.owner !== null && !g.capKeys.has(k)) {
        g.capKeys.add(k);
        g.flagCaptures++;
        log(`🚩 flagg ${f.n} → lag ${f.owner}`);
      }
    }
    if (round?.hill && round.hill.holder !== null) {
      const k = `h:${round.idx}:${round.hill.no}:${round.hill.holder}`;
      if (!g.capKeys.has(k)) {
        g.capKeys.add(k);
        g.hillHolds++;
        log(`👑 haug ${round.hill.no} → lag ${round.hill.holder}`);
      }
    }
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
    game: {
      claims: stats.game.claims,
      golden: stats.game.golden,
      lost: stats.game.lost,
      duplicateClaims: stats.game.duplicateClaims,
      rounds: stats.game.rounds,
      playlistDone: stats.game.playlistDone,
      catches: stats.game.catches,
      catchFails: stats.game.catchFails,
      zoneHits: stats.game.zoneHits,
      zonePen: stats.game.zonePen,
      bestCards: stats.game.bestCards,
      votes: stats.game.votes,
      events: stats.game.events,
      sprintMax: stats.game.sprintMax,
      prizes: stats.game.prizes,
      powerupsGot: stats.game.powerupsGot,
      powerupsUsed: stats.game.powerupsUsed,
      powerupFails: stats.game.powerupFails,
      missionsDone: stats.game.missionsDone,
      missionsConfirmed: stats.game.missionsConfirmed,
      teamSizes: stats.game.teamSizes,
      relayLegs: stats.game.relayLegs,
      relayBatonMax: stats.game.relayBatonMax,
      relayBatonCap: stats.game.relayBatonCap,
      teamPoints: stats.game.teamPoints,
      flagCaptures: stats.game.flagCaptures,
      hillHolds: stats.game.hillHolds,
      msgsSent: stats.game.msgsSent,
      msgsSeen: stats.game.msgsSeen,
      quizAnswered: stats.game.quizAnswered,
      quizRight: stats.game.quizRight,
      steps: stats.game.steps,
      statuses: stats.game.statuses,
    },
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
