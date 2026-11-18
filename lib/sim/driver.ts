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
import { hotColdCheck } from "@/lib/rules/hotcold";

import { fixDelayMs } from "@/lib/client/live";
import { createGpsFilter, type GpsFilter } from "@/lib/client/gpsFilter";

import { rng } from "./rng";
import { WsLink, type ServerLike, type WsCtor } from "./ws";
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
  /** ws transport: this bot's socket, send times of fixes not yet answered, last fix sent. */
  link?: WsLink;
  pendingFix?: { at: number; kind: FixKind; sampledAt: number }[];
  /** When the bot took its current position (its step); the fix's age is counted from here. */
  lastFixSampledAt?: number;
  lastFixSentAt?: number;
  /** A fix held back by the 1.9 s client throttle (useLiveTick's `pending`). */
  deferredFix?: ReturnType<typeof setTimeout> | null;
  /** Same jump rejection + smoothing as useDeviceGps. */
  gps?: GpsFilter;
  /** Terminal close (ended/kicked/...): the bot is finished. */
  done?: boolean;
  /** 4003 (kill switch): HTTP only from now on. */
  httpOnly?: boolean;
}

/** Why a fix went out: the 2 s interval, a hint from the room, or late because of the 1.9 s throttle. */
export type FixKind = "interval" | "hint" | "deferred";

/** Counters for the ws transport (SimStats.ws is set only in ws mode). */
export interface WsStats {
  fixView: number[];            // ms from the newest unanswered fix sent → {t:"view"}
  fixViewBy: Record<FixKind, number[]>;
  /** ms from the position being taken (bot step) → its view: what a geofence alarm waits for. */
  sampleView: number[];
  /** Fixes the room replaced by a newer one before writing (or whose view was lost): not latency samples. */
  superseded: number;
  /** Fixes held back by the client's 1.9 s throttle and sent later (like useLiveTick). */
  deferred: number;
  reconnects: number;
  iphoneDrops: number;
  httpFallbackTicks: number;
  hints: number;
  wsErrors: Record<string, number>;
  closes: Record<string, number>;
  terminal: Record<string, number>;
  hostPushes: number;
  hostAlarmMsgs: number;
  hostConnected: boolean;
  /** --kill-at: all sockets closed at once; recoveredAt when >= 95 % are back. */
  kill: { at: number; total: number; recoveredAt: number | null } | null;
  connectedNow: number;
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
  ws?: WsStats;
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
    hotcoldUsed: Record<string, number>;
    hotcoldFails: Record<string, number>;
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
  /** ws transport: base like ws://127.0.0.1:8787 (the path comes from /me live.path). */
  ws?: { base: string; impl?: WsCtor; iphoneFraction?: number };
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
      events: {}, eventKeys: new Set(), sprintMax: 0, prizes: 0, powerupsGot: 0, powerupsUsed: 0, powerupFails: {}, hotcoldUsed: {}, hotcoldFails: {}, missionsDone: 0, missionsConfirmed: 0,
      teamSizes: null, teamPoints: {}, flagCaptures: 0, hillHolds: 0, relayLegs: 0, relayBatonMax: 0, relayBatonCap: 0, relayLegsByRound: new Map(), capKeys: new Set(), msgsSent: 0, msgsSeen: 0, msgKeys: new Set(), quizAnswered: 0, quizRight: 0, steps: 0 },
  };
  const wsOn = !!opts.ws;
  if (wsOn) {
    stats.ws = { fixView: [], fixViewBy: { interval: [], hint: [], deferred: [] }, sampleView: [], superseded: 0, deferred: 0, reconnects: 0, iphoneDrops: 0, httpFallbackTicks: 0, hints: 0, wsErrors: {}, closes: {}, terminal: {},
      hostPushes: 0, hostAlarmMsgs: 0, hostConnected: false, kill: null, connectedNow: 0 };
  }
  let hostLink: WsLink | null = null;
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
    if (p.done) return;
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
    // Mirror of useDeviceGps: a held-back jump keeps the last fix (re-sent as the phone does).
    p.gps ??= createGpsFilter();
    const out = p.gps.push({ ...s.fix, at: now });
    if (out) {
      p.lastFix = { lat: out.lat, lng: out.lng, acc: out.acc, speed: out.speed };
      p.lastFixSampledAt = now;
    }
    const fx = p.lastFix;
    if (!fx) return;
    if (p.link?.connected && !p.httpOnly) {
      wsTick(p, "interval");
      return;
    }
    if (wsOn) stats.ws!.httpFallbackTicks++;
    const t0 = Date.now();
    const r = opts.transport.tick
      ? await opts.transport.tick(sessionId, p, fx)
      : await opts.transport.post(`/api/s/${sessionId}/tick`, {
          playerId: p.playerId,
          token: p.token,
          lat: fx.lat,
          lng: fx.lng,
          acc: fx.acc,
          speed: fx.speed,
          ts: Date.now(),
          // 0012: a moving bot reports ~2 steps per second it moved.
          steps: fx.speed > 0.5 ? Math.round(fx.speed * (tickMs / 1000) * 1.3) : undefined,
        });
    stats.latencies.push(Date.now() - t0);
    if (stats.latencies.length > 200_000) stats.latencies.splice(0, 100_000);
    if (r.status === 200) await applyView(p, r.data, fx);
    else err(`tick_${r.status}_${String(r.data.error ?? "")}`);
  }

  /**
   * Mirror of useLiveTick.wsSend: the same fixDelayMs throttle (1.9 s since the last send);
   * a tick (interval or hint) inside that window is sent once, at the earliest allowed
   * moment, with the then newest position.
   */
  function wsTick(p: SimPlayer, kind: FixKind) {
    if (!p.lastFix || p.done) return;
    const wait = fixDelayMs(Date.now(), p.lastFixSentAt ?? null);
    if (wait > 0) {
      if (!p.deferredFix) {
        stats.ws!.deferred++;
        p.deferredFix = setTimeout(() => {
          p.deferredFix = null;
          if (!stopped && p.link?.connected && !p.httpOnly) wsTick(p, "deferred");
        }, wait);
      }
      return;
    }
    sendFix(p, p.lastFix, kind);
  }

  function sendFix(p: SimPlayer, fix: BotFix, kind: FixKind) {
    const now = Date.now();
    const sent = p.link!.send({
      t: "fix",
      lat: fix.lat,
      lng: fix.lng,
      acc: fix.acc,
      speed: fix.speed,
      ts: now,
      steps: fix.speed > 0.5 ? Math.round(fix.speed * (tickMs / 1000) * 1.3) : undefined,
    });
    if (!sent) return;
    p.pendingFix ??= [];
    p.pendingFix.push({ at: now, kind, sampledAt: p.lastFixSampledAt ?? now });
    p.lastFixSentAt = now;
  }

  function onPlayerMsg(p: SimPlayer, m: ServerLike) {
    const w = stats.ws!;
    if (m.t === "view" && m.v) {
      const now = Date.now();
      // The room coalesces: a flush writes the player's NEWEST fix and answers it once.
      // So a view answers the newest fix sent; older unanswered ones were superseded (or
      // their view was lost while the socket was down) and are not latency samples.
      // With the throttle a fix cannot be sent during the flush that answers the
      // previous one (flush ≈ 0.1 s), so "newest" is the answered one.
      const q = (p.pendingFix ??= []);
      const f = q.pop();
      w.superseded += q.length;
      q.length = 0;
      if (f !== undefined) {
        w.fixView.push(now - f.at);
        w.fixViewBy[f.kind].push(now - f.at);
        w.sampleView.push(now - f.sampledAt);
        if (w.sampleView.length > 200_000) w.sampleView.splice(0, 100_000);
        if (w.fixView.length > 200_000) w.fixView.splice(0, 100_000);
        if (w.fixViewBy[f.kind].length > 200_000) w.fixViewBy[f.kind].splice(0, 100_000);
      }
      void applyView(p, m.v, p.lastFix);
    } else if (m.t === "hint") {
      w.hints++;
      wsTick(p, "hint"); // like useLiveTick: a hint is a tick, subject to the same 1.9 s throttle
    } else if (m.t === "err") {
      const k = `ws_err_${String(m.error ?? "")}`;
      err(k);
      w.wsErrors[String(m.error ?? "")] = (w.wsErrors[String(m.error ?? "")] ?? 0) + 1;
    }
  }

  function connectedCount() {
    return players.filter((p) => p.link?.connected).length;
  }

  /** Everything a tick answer (HTTP response or ws {t:"view"}) does to the bot and the counters. */
  async function applyView(p: SimPlayer, data: Record<string, unknown>, fix: BotFix | null) {
    stats.ticks++;
    p.lastTickAt = Date.now();
    const z0 = (p.view as { zone?: { hits: number; pen: number } } | null)?.zone;
    const z1 = (data as { zone?: { hits: number; pen: number } }).zone;
    if (z1) {
      // Per-round counters: a drop means a new round started.
      stats.game.zoneHits += z0 && z1.hits >= z0.hits ? z1.hits - z0.hits : z1.hits;
      stats.game.zonePen += z0 && z1.pen >= z0.pen ? z1.pen - z0.pen : z1.pen;
    }
    const prevView = p.view;
    p.view = data;
    const cer = (data as { ceremony?: { best: unknown; voted: boolean | null } }).ceremony;
    if (cer?.best && !voted.has(p.playerId)) {
      voted.add(p.playerId);
      stats.game.bestCards++;
      const v = await opts.transport.post(`/api/s/${sessionId}/again`, { playerId: p.playerId, token: p.token, yes: p.nickname.length % 3 !== 0 });
      if (v.status === 200) stats.game.votes++;
      else err(`again_${v.status}`);
    }
    p.bot.observe(data as never);
    const claimed = data.claimed as { post_id: string; kind: string } | null | undefined;
    if (claimed) {
      stats.game.claims++;
      if (claimed.kind === "golden") stats.game.golden++;
      if (stats.game.claimedIds.has(claimed.post_id)) stats.game.duplicateClaims++;
      stats.game.claimedIds.add(claimed.post_id);
    }
    if (data.lost) stats.game.lost++;
    void tryCatch(p);
    void tryEvent(p, prevView);
    void tryTeam(p);
    void tryQuiz(p);
    if (fix && fix.speed > 0.5) stats.game.steps += Math.round(fix.speed * (tickMs / 1000) * 1.3);
    // A signal-loss check is satisfied once the bot reports again.
    stats.alarms = stats.alarms.filter((a) => !(a.player === p.playerId && a.kind === "signal" && a.seenAt === null && a.expectedAt > Date.now()));
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
  const lastHc = new Map<string, number>();
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
    // Snus / Termometer (0017): a hunter or prey tries one now and then; the 60 s cooldown and
    // «walk first» answers count as expected refusals, anything else as a failure.
    if (hotColdCheck("sniff", v.round?.mode as never, v.role ?? "neutral") === null
        && Date.now() - (lastHc.get(p.playerId) ?? 0) > 6000 && p.kind !== "hider" && Math.random() < 0.3) {
      lastHc.set(p.playerId, Date.now());
      const kind = Math.random() < 0.5 ? "sniff" : "thermo";
      const r = await opts.transport.post(`/api/s/${sessionId}/event`, { playerId: p.playerId, token: p.token, action: "hotcold", kind });
      if (r.status === 200) {
        stats.game.hotcoldUsed[kind] = (stats.game.hotcoldUsed[kind] ?? 0) + 1;
      } else {
        const k = String(r.data.error ?? r.status);
        stats.game.hotcoldFails[k] = (stats.game.hotcoldFails[k] ?? 0) + 1;
      }
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

  /** Teacher HTTP snapshot. matchAlarms=false: the host socket does the alarm matching. */
  async function pollHost(matchAlarms = true, at?: number) {
    if (!opts.hostToken || stopped) return;
    const r = await opts.transport.post(`/api/s/${sessionId}/snapshot`, { hostToken: opts.hostToken });
    if (r.status !== 200) return err(`snapshot_${r.status}`);
    await ingestSnapshot(r.data, matchAlarms, at ?? Date.now());
  }

  /** Same data from GET/POST snapshot or a {t:"host"} push. */
  async function ingestSnapshot(data: Record<string, unknown>, matchAlarms: boolean, now: number) {
    const r = { data };
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
    if (!matchAlarms) return;
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

  function startLinks(path: string) {
    const o = opts.ws!;
    const impl = o.impl ?? (globalThis as unknown as { WebSocket: WsCtor }).WebSocket;
    const url = o.base.replace(/\/$/, "") + path;
    const w = stats.ws!;
    const iphone = rng(opts.seed * 31 + 7);
    const frac = o.iphoneFraction ?? 0.1;
    players.forEach((p, idx) => {
      const r = rng(opts.seed * 977 + p.i + 1);
      p.pendingFix = [];
      p.link = new WsLink({
        url,
        impl,
        rand: r,
        auth: { t: "auth", role: "player", playerId: p.playerId, token: p.token },
        onMessage: (m) => onPlayerMsg(p, m),
        onReconnect: () => void w.reconnects++,
        onClose: (code) => {
          w.closes[code] = (w.closes[code] ?? 0) + 1;
          // Fixes sent on a dead socket: their views may never come. Not latency samples.
          w.superseded += p.pendingFix?.length ?? 0;
          p.pendingFix = [];
          if (p.deferredFix) clearTimeout(p.deferredFix);
          p.deferredFix = null;
        },
        onTerminal: (code) => {
          p.done = true;
          w.terminal[code] = (w.terminal[code] ?? 0) + 1;
          log(`${p.nickname}: socket lukket ${code} (ferdig)`);
        },
        onDisabled: () => {
          p.httpOnly = true;
          log(`${p.nickname}: 4003, faller tilbake til HTTP`);
        },
      });
      // iPhone: ~10 % (seeded) lose the socket every 60-120 s and come back 1-5 s later.
      if (iphone() < frac) {
        const loop = () => {
          const t = setTimeout(() => {
            if (stopped || p.done || p.httpOnly) return;
            if (p.link!.connected) {
              w.iphoneDrops++;
              p.link!.drop(1000 + Math.round(4000 * r()));
            }
            loop();
          }, 60_000 + Math.round(60_000 * r()));
          timers.push(t as unknown as ReturnType<typeof setInterval>);
        };
        loop();
      }
      const t = setTimeout(() => p.link!.start(), idx * 20);
      timers.push(t as unknown as ReturnType<typeof setInterval>);
    });
    if (opts.hostToken) {
      hostLink = new WsLink({
        url,
        impl,
        rand: rng(opts.seed * 53 + 11),
        auth: { t: "auth", role: "host", hostToken: opts.hostToken },
        onState: (c) => void (w.hostConnected = c),
        onReconnect: () => void w.reconnects++,
        onMessage: (m) => {
          if (m.t === "host" && m.v) {
            w.hostPushes++;
            void ingestSnapshot(m.v, true, Date.now());
          } else if (m.t === "alarm") {
            w.hostAlarmMsgs++;
            void pollHost(true, Date.now());
          }
        },
      });
      hostLink.start();
    }
    timers.push(setInterval(() => {
      w.connectedNow = connectedCount();
      const k = w.kill;
      if (k && k.recoveredAt === null) {
        const live = players.filter((q) => !q.done && !q.httpOnly).length;
        if (live > 0 && w.connectedNow >= Math.ceil(live * 0.95)) k.recoveredAt = Date.now();
      }
    }, 200));
  }

  /** --kill-at: close every socket at once (chase-live redeploy). */
  function killAll() {
    const w = stats.ws;
    if (!w) return;
    w.kill = { at: Date.now(), total: connectedCount(), recoveredAt: null };
    for (const p of players) p.link?.kill();
    hostLink?.kill();
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
    const live = me.data.live as { path?: string } | null | undefined;
    if (wsOn && !live?.path) {
      throw new Error("Serveren har LIVE_TRANSPORT=http (live er null i /me). Sett LIVE_TRANSPORT=ws på serveren, eller kjør uten --transport ws.");
    }
    for (const p of players) {
      p.bot = createBot(p.kind, geo, {
        seed: opts.seed * 1000 + p.i,
        sosAfterS: opts.sosAfterS,
        dropoutAfterS: opts.dropoutAfterS,
        dropoutForS: opts.dropoutForS,
      });
    }
    if (wsOn && live?.path) startLinks(live.path);
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
    let pollN = 0;
    if (opts.hostToken) {
      timers.push(setInterval(() => {
        // ws: the host socket matches alarms; HTTP only keeps the game bookkeeping going (every 5th s)
        // and takes over alarm matching while the host socket is down.
        const hostUp = wsOn && !!hostLink?.connected;
        if (hostUp && ++pollN % 5 !== 0) return;
        void pollHost(!hostUp);
      }, 1000));
    }
    if (opts.onUpdate) timers.push(setInterval(() => opts.onUpdate!(players, stats), 1000));
    return { sessionId, geo };
  })();

  return {
    ready,
    players,
    stats,
    kill: killAll,
    stop() {
      stopped = true;
      for (const p of players) {
        p.link?.stop();
        if (p.deferredFix) clearTimeout(p.deferredFix);
      }
      hostLink?.stop();
      for (const t of timers) {
        clearInterval(t);
        clearTimeout(t as unknown as ReturnType<typeof setTimeout>);
      }
    },
  };
}

/** fetch-based transport against a Chase base URL. */
export function httpTransport(base: string, extraHeaders?: Record<string, string>): Transport {
  return {
    async post(path, body) {
      try {
        const res = await fetch(base + path, {
          method: "POST",
          headers: { "content-type": "application/json", ...extraHeaders },
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
      hotcoldUsed: stats.game.hotcoldUsed,
      hotcoldFails: stats.game.hotcoldFails,
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
    transport: stats.ws ? "ws" : "http",
    ws: stats.ws ? summarizeWs(stats) : undefined,
    ticks: stats.ticks,
    errors: stats.errors,
    tickMs: { p50: percentile(lat, 50), p95: percentile(lat, 95), p99: percentile(lat, 99), max: lat.length ? Math.max(...lat) : 0 },
    alarms: {
      expected: stats.alarms.length,
      seen: alarmLat.length,
      pending: stats.alarms.filter((a) => a.seenAt === null).map((a) => `${a.kind}@${Math.round((Date.now() - a.expectedAt) / 1000)}s`),
      maxDelayS: alarmLat.length ? Math.max(...alarmLat) : null,
      p95S: alarmLat.length ? percentile(alarmLat, 95) : null,
      byKind: Object.fromEntries(
        (["sos", "forbidden", "outside", "signal"] as const).map((k) => {
          const xs = stats.alarms.filter((a) => a.kind === k && a.seenAt !== null).map((a) => (a.seenAt! - a.expectedAt) / 1000);
          return [k, xs.length ? { n: xs.length, maxS: Math.max(...xs) } : null];
        }),
      ),
    },
  };
}

/** ws-mode numbers: fix → view latency, reconnects, closes, and the --kill-at recovery. */
export function summarizeWs(stats: SimStats) {
  const w = stats.ws!;
  const lat = w.fixView;
  const k = w.kill;
  return {
    superseded: w.superseded,
    deferred: w.deferred,
    sampleView: { p50: percentile(w.sampleView, 50), p95: percentile(w.sampleView, 95), p99: percentile(w.sampleView, 99) },
    fixViewBy: Object.fromEntries(
      (Object.entries(w.fixViewBy) as [FixKind, number[]][]).map(([k, xs]) => [k, { n: xs.length, p50: percentile(xs, 50), p95: percentile(xs, 95) }]),
    ),
    fixView: { n: lat.length, p50: percentile(lat, 50), p95: percentile(lat, 95), p99: percentile(lat, 99), max: lat.length ? Math.max(...lat) : 0 },
    reconnects: w.reconnects,
    iphoneDrops: w.iphoneDrops,
    httpFallbackTicks: w.httpFallbackTicks,
    hints: w.hints,
    connectedNow: w.connectedNow,
    closes: w.closes,
    terminal: w.terminal,
    wsErrors: w.wsErrors,
    host: { connected: w.hostConnected, pushes: w.hostPushes, alarmMsgs: w.hostAlarmMsgs },
    kill: k
      ? {
          at: new Date(k.at).toISOString(),
          connectedAtKill: k.total,
          recoveryS: k.recoveredAt === null ? null : Math.round(((k.recoveredAt - k.at) / 1000) * 10) / 10,
          // Alarms that came due after the kill and still had not reached the teacher 5 s later.
          missedAlarms: stats.alarms.filter((a) => a.expectedAt >= k.at && a.seenAt === null && Date.now() - a.expectedAt > 5000).length,
        }
      : null,
  };
}
