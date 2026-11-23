// Live-rewards checks for the simulator (`--live-rewards`, ADR-040 contract). Pure: the driver feeds it
// tick views and fixes, scripts/sim.mjs asks for the problems. Nothing here reads a position from anywhere
// but the bots' own generated fixes, and nothing is logged.
//
// Contract (new tick fields): `live { on, mult, streak_s, next_s, frozen }`, `tag.revealed[{ id, pos, age_s }]`
// (hunters only), `posts[].flash` + `expires_at`.

export const LIVE_CHECK = {
  /** Silence longer than this (s) means the live streak and the clock restart (server gap_s). */
  gapS: 20,
  /** Hunters see a silent player's last position after this many seconds (server reveal_s)… */
  revealS: 20,
  /** …and the sim demands it within this much more (plus `latencyS` for the transport). */
  revealSlackS: 2,
  latencyS: 1,
  /** The revealed pos must be within this of the last fix the locker actually sent. */
  matchM: 5,
  /** After coming back the streak must be below this. */
  streakResetS: 10,
  /** Multiplier steps (server t1_s / t2_s) and how much we tolerate around the thresholds. */
  t1S: 120,
  t2S: 240,
  m1: 1.25,
  m2: 1.5,
  tolS: 5,
  /** Smittejakt survival pays ~1 point per 5 live seconds. */
  secPerPoint: 5,
  /** Rounding, a claim or a catch around the window. */
  pointSlack: 3,
} as const;

export interface LL {
  lat: number;
  lng: number;
}

export function distanceM(a: LL, b: LL): number {
  const dy = (a.lat - b.lat) * 111_320;
  const dx = (a.lng - b.lng) * 111_320 * Math.cos(((a.lat + b.lat) / 2 * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

export type LockerMode = "hide" | "tag" | "other";

/** The parts of a tick view the checks look at (everything optional: an old server has none of the new fields). */
export interface LiveView {
  status?: string;
  role?: string;
  round_idx?: number;
  stats?: { points?: number; round_points?: number };
  live?: { on?: boolean; mult?: number; streak_s?: number; next_s?: number | null; frozen?: boolean } | null;
  tag?: { variant?: string; revealed?: { id: string; pos: LL; age_s?: number }[]; hide?: { released?: boolean } } | null;
  posts?: { id?: string; kind?: string; flash?: boolean }[] | null;
  claimed?: unknown;
  scoreo?: { claimed?: unknown } | null;
}

export function viewMode(v: LiveView | null | undefined): LockerMode {
  if (v?.tag?.variant === "hide") return "hide";
  if (v?.tag) return "tag";
  return "other";
}

/** One stretch of silence of one locker, from the last call it made to its first view after coming back. */
export interface LockerWindow {
  playerId: string;
  kind: string;
  /** Wall clock (ms) of the last fix the locker sent, and where it was (what the server stored). */
  lastSentAt: number;
  lastPos: LL;
  startedAt: number;
  returnedAt: number | null;
  mode: LockerMode;
  roundIdx: number | null;
  before: { points: number; roundPoints: number; streakS: number | null } | null;
  /** Hunter views at/after the reveal deadline (the reveal must show by then), and the first sighting of the locker. */
  hunterViewsDue: number;
  revealSeenAt: number | null;
  idLeak: boolean;
}

export function newWindow(o: { playerId: string; kind: string; lastSentAt: number; lastPos: LL; now: number; before: LiveView | null }): LockerWindow {
  const v = o.before;
  const hasPts = typeof v?.stats?.points === "number";
  return {
    playerId: o.playerId,
    kind: o.kind,
    lastSentAt: o.lastSentAt,
    lastPos: o.lastPos,
    startedAt: o.now,
    returnedAt: null,
    mode: viewMode(v),
    roundIdx: v?.round_idx ?? null,
    before: hasPts && v?.status === "live" ? { points: v!.stats!.points!, roundPoints: v!.stats!.round_points ?? v!.stats!.points!, streakS: v?.live?.streak_s ?? null } : null,
    hunterViewsDue: 0,
    revealSeenAt: null,
    idLeak: false,
  };
}

export const revealDeadlineMs = (): number => (LIVE_CHECK.revealS + LIVE_CHECK.revealSlackS + LIVE_CHECK.latencyS) * 1000;

/** Does this `tag.revealed` list contain the locker (matched on position, the id is salted)? */
export function revealMatches(revealed: { pos: LL }[] | undefined, pos: LL, maxM: number = LIVE_CHECK.matchM): boolean {
  return (revealed ?? []).some((r) => r?.pos && distanceM(r.pos, pos) <= maxM);
}

/** A hunter's tick view while a locker is silent. Hunters before Gjemsel's release are not expected to see anything. */
export function recordHunterView(w: LockerWindow, v: LiveView, now: number, playerIds: ReadonlySet<string> = new Set()): void {
  if (w.returnedAt !== null || v.role !== "hunter" || v.status !== "live") return;
  if (v.tag?.variant === "hide" && !v.tag.hide?.released) return;
  if (!v.tag) return;
  const list = v.tag.revealed;
  if (list?.some((r) => playerIds.has(r.id))) w.idLeak = true;
  if (revealMatches(list, w.lastPos) && w.revealSeenAt === null) w.revealSeenAt = now;
  // Only a view that arrives after reveal_s + slack can say «too late».
  if (now - w.lastSentAt >= revealDeadlineMs()) w.hunterViewsDue++;
}

/** locker gets no time points for the silent window (Smittejakt ≈ live seconds / 5, Gjemsel/other: none). */
export function pointsProblem(w: LockerWindow, after: LiveView, liveS: number): string | null {
  if (!w.before || after.status !== "live" || typeof after.stats?.points !== "number") return null;
  if (w.roundIdx !== null && after.round_idx !== undefined && after.round_idx !== w.roundIdx) return null; // new round: not comparable
  if (after.claimed || after.scoreo?.claimed) return null; // a claim in the first tick back pays for itself
  const silentS = ((w.returnedAt ?? w.startedAt) - w.lastSentAt) / 1000;
  const d = after.stats.points - w.before.points;
  const dr = (after.stats.round_points ?? after.stats.points) - w.before.roundPoints;
  const mult = LIVE_CHECK.m2; // the best multiplier a streak could have had
  const allowed = (w.mode === "tag" ? Math.ceil(((liveS / LIVE_CHECK.secPerPoint) * mult)) : 0) + LIVE_CHECK.pointSlack;
  const worst = Math.max(d, dr);
  return worst > allowed
    ? `${w.kind} fikk +${worst} poeng over ${Math.round(silentS)} s uten tick (maks ${allowed}; ${w.mode}), tidspoeng for stille tid`
    : null;
}

export function streakProblem(w: LockerWindow, after: LiveView): string | null {
  const l = after.live;
  if (!l || !l.on || l.frozen) return null;
  if (typeof l.streak_s !== "number") return null;
  return l.streak_s >= LIVE_CHECK.streakResetS ? `${w.kind}: live.streak_s ${l.streak_s} etter ${Math.round(((w.returnedAt ?? w.startedAt) - w.lastSentAt) / 1000)} s stille (skulle være < ${LIVE_CHECK.streakResetS})` : null;
}

export function revealProblem(w: LockerWindow): string | null {
  if (w.idLeak) return `${w.kind}: tag.revealed.id er spiller-id i klartekst (skal være saltet)`;
  if (w.hunterViewsDue === 0) return null; // no hunter looked after the deadline: nothing to judge
  if (w.revealSeenAt === null) return `${w.kind}: jegerne så aldri lockeren i tag.revealed (${LIVE_CHECK.revealS + LIVE_CHECK.revealSlackS} s etter siste tick)`;
  const lateMs = w.revealSeenAt - w.lastSentAt;
  return lateMs > revealDeadlineMs() ? `${w.kind}: reveal etter ${(lateMs / 1000).toFixed(1)} s (maks ${LIVE_CHECK.revealS + LIVE_CHECK.revealSlackS} s)` : null;
}

/** Expected multiplier for a live streak, null in the tolerance band around a threshold. */
export function expectedMult(streakS: number): 1 | 1.25 | 1.5 | null {
  const { t1S, t2S, tolS } = LIVE_CHECK;
  if (streakS < t1S - tolS) return 1;
  if (streakS >= t1S + tolS && streakS < t2S - tolS) return 1.25;
  if (streakS >= t2S + tolS) return 1.5;
  return null;
}

export interface LiveStats {
  viewsWithLive: number;
  viewsWithoutLive: number;
  maxStreakS: number;
  mult125Seen: number;
  mult15Seen: number;
  multBad: number;
  multBadExample: string | null;
  windows: LockerWindow[];
  problems: string[];
  flashSeen: Set<string>;
  flashClaimed: number;
}

export function newLiveStats(): LiveStats {
  return { viewsWithLive: 0, viewsWithoutLive: 0, maxStreakS: 0, mult125Seen: 0, mult15Seen: 0, multBad: 0, multBadExample: null, windows: [], problems: [], flashSeen: new Set(), flashClaimed: 0 };
}

/** Per-view bookkeeping for ordinary bots (lockers are judged on their return instead). */
export function observeView(ls: LiveStats, v: LiveView): void {
  if (!v.live) {
    ls.viewsWithoutLive++;
  } else {
    ls.viewsWithLive++;
    const l = v.live;
    if (l.on && !l.frozen && typeof l.streak_s === "number" && typeof l.mult === "number") {
      ls.maxStreakS = Math.max(ls.maxStreakS, l.streak_s);
      if (l.mult === LIVE_CHECK.m1) ls.mult125Seen++;
      if (l.mult === LIVE_CHECK.m2) ls.mult15Seen++;
      const want = expectedMult(l.streak_s);
      if (want !== null && l.mult !== want) {
        ls.multBad++;
        ls.multBadExample ??= `streak ${l.streak_s} s gir ×${l.mult} (ventet ×${want})`;
      }
    }
  }
  for (const p of v.posts ?? []) if ((p.kind === "flash" || p.flash) && p.id) ls.flashSeen.add(p.id);
}

export function noteClaim(ls: LiveStats, postId: string | undefined): void {
  if (postId && ls.flashSeen.has(postId)) ls.flashClaimed++;
}

/** Judge a window on the first view after the locker came back; returns its problems. */
export function judgeWindow(w: LockerWindow, after: LiveView, tickS: number): string[] {
  const out = [revealProblem(w), pointsProblem(w, after, tickS * 2), streakProblem(w, after)];
  return out.filter((x): x is string => x !== null);
}

export interface LiveCheckCtx {
  /** The run had a teacher (alarms are matched). */
  hasHost: boolean;
  /** Plan text as given to --plan (or "" for one free round). */
  plan: string;
  bots: number;
  minutes: number;
  alarms: { player: string; kind: string; seenAt: number | null }[];
  lockers: number;
}

/** Everything `--assert --live-rewards` demands on top of the normal gate. */
export function liveRewardsProblems(ls: LiveStats, ctx: LiveCheckCtx): string[] {
  const p = [...ls.problems];
  if (ls.viewsWithLive === 0) {
    p.push("--live-rewards: ingen tick-svar hadde `live` (serveren mangler 0024? sjekk at du kjører mot ny server)");
    return p;
  }
  const secs = String(ctx.plan).split(",").map((x) => Number(x.split(":")[1]) || 0);
  const longRound = ctx.plan ? secs.some((s) => s >= 180) : ctx.minutes >= 3;
  if (ls.multBad > 0) p.push(`live.mult stemmer ikke med streak_s i ${ls.multBad} tick (${ls.multBadExample})`);
  if (longRound && ctx.bots >= 5 && ls.maxStreakS < LIVE_CHECK.t1S + LIVE_CHECK.tolS) p.push(`ingen bot nådde ${LIVE_CHECK.t1S} s live-rekke i en lang runde (maks ${ls.maxStreakS} s)`);
  else if (ls.maxStreakS >= LIVE_CHECK.t1S + LIVE_CHECK.tolS && ls.mult125Seen === 0) p.push("ingen bot fikk ×1,25 etter 120 s live");
  if (ctx.lockers > 0) {
    const judged = ls.windows.filter((w) => w.returnedAt !== null);
    if (judged.length === 0) p.push("lockeren ble aldri stille og tilbake i løpet av kjøringen (kjør lenger, ≥ 3 min live)");
    if (ctx.hasHost) {
      for (const w of judged) {
        if ((w.returnedAt! - w.lastSentAt) / 1000 < 62) continue;
        if (!ctx.alarms.some((a) => a.player === w.playerId && a.kind === "signal" && a.seenAt !== null)) p.push(`${w.kind}: ingen signaltap-alarm til læreren etter ${Math.round((w.returnedAt! - w.lastSentAt) / 1000)} s stille`);
      }
    }
  }
  const postsPlan = /posts/.test(ctx.plan) && secs.some((s) => s >= 180);
  if (postsPlan && ctx.bots >= 10) {
    if (ls.flashSeen.size === 0) p.push("ingen lynpost (kind: flash) dukket opp i Postjakt");
    else if (ls.flashClaimed === 0) p.push(`${ls.flashSeen.size} lynposter, ingen ble tatt`);
  }
  return p;
}

export function summarizeLive(ls: LiveStats) {
  return {
    viewsWithLive: ls.viewsWithLive,
    viewsWithoutLive: ls.viewsWithoutLive,
    maxStreakS: ls.maxStreakS,
    mult: { x125: ls.mult125Seen, x15: ls.mult15Seen, bad: ls.multBad },
    lockers: ls.windows.map((w) => ({
      kind: w.kind,
      silentS: w.returnedAt ? Math.round((w.returnedAt - w.lastSentAt) / 1000) : null,
      mode: w.mode,
      revealS: w.revealSeenAt ? Math.round((w.revealSeenAt - w.lastSentAt) / 100) / 10 : null,
    })),
    flash: { seen: ls.flashSeen.size, claimed: ls.flashClaimed },
    problems: ls.problems,
  };
}
