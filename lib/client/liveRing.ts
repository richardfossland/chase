// Live-belønning (0024), klientsiden: rene hjelpefunksjoner. Alt her er visning og varsler,
// serveren avgjør multiplikator og poeng. Ingenting her rører sikkerhetsbanneret eller SOS
// (CLAUDE.md regel 4): forvarselet er en egen stripe under det.

import type { LiveView, PostView, SessionStatus, TagView } from "@/lib/client/api";

/** Speiler LIVE i lib/rules/live.ts (t1_s, t2_s, gap_s): bare for ringens form, aldri for poeng. */
export const RING = { t1_s: 120, t2_s: 240, warn_after_s: 10, gap_s: 20 } as const;

/** Statuser der live-ringen i det hele tatt vises (grå når `frozen`). */
const RING_STATUSES: readonly SessionStatus[] = ["live", "paused", "breather"];

/** Vis ringen bare når serveren har sendt `live` og runden er i gang (eller fryst i pause). */
export function showLiveRing(live: LiveView | null | undefined, status: SessionStatus): live is LiveView {
  return !!live && RING_STATUSES.includes(status);
}

/** Hvor langt mot neste trinn, 0..1. Ved siste trinn (`next_s` null) er ringen full. */
export function ringFraction(live: LiveView): number {
  if (live.next_s === null) return 1;
  const start = live.mult >= 1.5 ? RING.t2_s : live.mult >= 1.25 ? RING.t1_s : 0;
  const end = live.streak_s + Math.max(0, live.next_s);
  if (end <= start) return 0;
  return Math.min(1, Math.max(0, (live.streak_s - start) / (end - start)));
}

/** «×1,25» / «×1,5», eller null ved ×1 (da vises bare ringen). Komma som desimaltegn. */
export function multLabel(mult: number): string | null {
  if (!(mult > 1)) return null;
  return `×${String(mult).replace(".", ",")}`;
}

export type RingTone = "frozen" | "off" | "on";

/** Grå og fryst i pause, pustepause og samling; dempet når telefonen ikke teller (dommer, sitter over). */
export function ringTone(live: LiveView, status: SessionStatus): RingTone {
  if (live.frozen || status !== "live") return "frozen";
  return live.on ? "on" : "off";
}

export type WarningKind = "streak" | "reveal";

export interface WarningInput {
  /** Sekunder siden siste GPS-fix på telefonen (Infinity = aldri fått). */
  fixAgeS: number;
  status: SessionStatus;
  live: LiveView | null | undefined;
  /** Smittejakt/Gjemsel: byttet/gjemmeren blir synlig for jegerne ved stillhet. */
  tag: Pick<TagView, "variant"> | null | undefined;
  role: string | null | undefined;
  /** Gjemsel før slipp: ingen avsløring ennå (bare rekka er i spill). */
  hidePending?: boolean;
}

/**
 * Forvarsel «Rekka ryker om 10 s» / «Du blir synlig om 10 s». Bare i en aktiv, ikke-fryst runde, og
 * bare mellom 10 s og 20 s uten GPS: etter 20 s er rekka allerede røket og GPS-tap-banneret tar over.
 * Null betyr ingen stripe. Safety-bannere avgjøres andre steder og påvirkes aldri av dette.
 */
export function liveWarning(i: WarningInput): WarningKind | null {
  if (i.status !== "live" || !i.live || i.live.frozen || !i.live.on) return null;
  if (!Number.isFinite(i.fixAgeS) || i.fixAgeS <= RING.warn_after_s || i.fixAgeS > RING.gap_s) return null;
  if (i.tag && i.role === "prey" && !i.hidePending) return "reveal";
  return "streak";
}

/** Sekunder igjen til forvarselet slår til (for en eventuell nedtelling), minst 0. */
export function warnLeftS(fixAgeS: number): number {
  return Math.max(0, Math.ceil(RING.gap_s - fixAgeS));
}

// ── 🔒-beacon ─────────────────────────────────────────────────────────────

const AWAY_STATUSES: readonly SessionStatus[] = ["live", "paused", "breather", "countdown", "gathering"];
/** Ikke send oftere enn dette: visibilitychange og pagehide kommer ofte rett etter hverandre. */
export const AWAY_MIN_GAP_MS = 5000;

export interface AwayInput {
  ready: boolean;
  ended: boolean;
  kicked: boolean;
  status: SessionStatus;
  /** Epoch ms for forrige beacon, null = aldri. */
  lastSentAt: number | null;
  nowMs: number;
}

/** Skal telefonen si fra om skjult side nå? Bare i en aktiv økt, og ikke i spinn. */
export function shouldSendAway(i: AwayInput): boolean {
  if (!i.ready || i.ended || i.kicked) return false;
  if (!AWAY_STATUSES.includes(i.status)) return false;
  return i.lastSentAt === null || i.nowMs - i.lastSentAt >= AWAY_MIN_GAP_MS;
}

/** Beacon-kropp. Tokenet bare i body, aldri i URL (se /api/s/[id]/away). */
export function awayBody(token: string): string {
  return JSON.stringify({ token });
}

export function awayUrl(sessionId: string): string {
  return `/api/s/${sessionId}/away`;
}

/** Send beaconet. Fire-and-forget: feil svelges, spillet påvirkes aldri. Returnerer om nettleseren tok imot. */
export function sendAway(sessionId: string, token: string): boolean {
  try {
    if (typeof navigator === "undefined" || typeof navigator.sendBeacon !== "function") return false;
    return navigator.sendBeacon(awayUrl(sessionId), new Blob([awayBody(token)], { type: "text/plain;charset=UTF-8" }));
  } catch {
    return false;
  }
}

// ── Lynpost ───────────────────────────────────────────────────────────────

export function isFlash(p: Pick<PostView, "flash" | "kind">): boolean {
  return p.kind === "flash" || p.flash === true;
}

/** Sekunder til en lynpost utløper (serverklokke via offsetMs), eller null uten frist. Aldri negativ. */
export function flashLeftS(expiresAt: string | null | undefined, nowMs: number, offsetMs: number): number | null {
  if (!expiresAt) return null;
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.ceil((t - (nowMs + offsetMs)) / 1000));
}

/** Nye lynposter (ikke tatt, ikke sett før): driver toast, lyd og blink. Muterer ikke `seen`. */
export function newFlashPosts(posts: readonly PostView[] | null | undefined, seen: ReadonlySet<string>): PostView[] {
  return (posts ?? []).filter((p) => isFlash(p) && !p.claimed_by && !seen.has(p.id));
}

/** Den lynposten som utløper først, til overskrift-nedtellingen. */
export function soonestFlash(posts: readonly PostView[] | null | undefined, nowMs: number, offsetMs: number): { post: PostView; leftS: number } | null {
  let best: { post: PostView; leftS: number } | null = null;
  for (const p of posts ?? []) {
    if (!isFlash(p) || p.claimed_by) continue;
    const left = flashLeftS(p.expires_at, nowMs, offsetMs);
    if (left === null || left <= 0) continue;
    if (!best || left < best.leftS) best = { post: p, leftS: left };
  }
  return best;
}

// ── Avslørte (jegerkart) ──────────────────────────────────────────────────

/** Rund alderen av til hele sekunder (aldri negativ) for «låst skjerm, 25 s». */
export function revealedAgeS(ageS: number): number {
  return Math.max(0, Math.round(ageS));
}

/** Sunn visning: bare gyldige punkter, eldste sist. */
export function revealedForMap(r: TagView["revealed"] | null | undefined): { pos: { lat: number; lng: number }; age_s: number }[] {
  return (r ?? [])
    .filter((x) => Number.isFinite(x.pos?.lat) && Number.isFinite(x.pos?.lng))
    .map((x) => ({ pos: x.pos, age_s: revealedAgeS(x.age_s) }))
    .sort((a, b) => a.age_s - b.age_s);
}

// ── Jeger nær (gjemmer) ───────────────────────────────────────────────────

/** `hunter_close` er sterkere enn `hunter_near`; immun spiller får ingen rød ring (som før). */
export function hunterAlert(tag: Pick<TagView, "hunter_near" | "hunter_close"> | null | undefined, immune: boolean): "close" | "near" | null {
  if (!tag || immune) return null;
  if (tag.hunter_close) return "close";
  return tag.hunter_near ? "near" : null;
}

// ── Lærer ─────────────────────────────────────────────────────────────────

/** Er eleven låst (sa fra om skjult side etter siste fix)? Mangler feltet mot gammel DB = nei. */
export function isAway(p: { away?: boolean } | null | undefined): boolean {
  return p?.away === true;
}

/** Mengden av elev-id-er som er låst, til signal-alarmens «(låst skjerm)». */
export function awayIds(players: readonly { id: string; away?: boolean }[]): Set<string> {
  return new Set(players.filter((p) => p.away === true).map((p) => p.id));
}

/** Lengste live-rekke til resultatkortet: bare når serveren sender den og den er over 0. */
export function bestStreakS(stats: { best_streak_s?: number } | null | undefined): number | null {
  const s = stats?.best_streak_s;
  return typeof s === "number" && Number.isFinite(s) && s > 0 ? Math.floor(s) : null;
}
