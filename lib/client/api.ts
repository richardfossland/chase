"use client";

// Typed fetch wrappers around the Chase API (pattern from Sjakk's lib/client/api.ts).
// Tokens and positions travel only in POST bodies — never in URLs.

import type { Badge, Plan, PlanRound, RoundMode } from "@/lib/rules/game";
import type { EventKind, Powerup } from "@/lib/rules/events";
import type { BestCard, PodiumCat } from "@/lib/rules/podiums";
import type { ZoneState } from "@/lib/rules/zone";
import type { TeamMsgKind } from "@/lib/rules/teams";
import type { QuizItem } from "@/lib/rules/quiz";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public payload: unknown,
  ) {
    super(code);
  }
}

const DEFAULT_TIMEOUT = 8000;

/** fetch + JSON parse under ONE hard timeout that also covers the body read
 * (a stalled body stream must not hang the UI). Network/timeout → ApiError(0). */
export async function timedJson(
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const data = await res.json().catch((e) => {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      return {};
    });
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === "AbortError";
    throw new ApiError(0, aborted ? "timeout" : "network", null);
  } finally {
    clearTimeout(t);
  }
}

async function post<T>(url: string, body: unknown, timeoutMs?: number): Promise<T> {
  const { ok, status, data } = await timedJson(
    url,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" },
    timeoutMs,
  );
  if (!ok) {
    const code = (data as { error?: string } | null)?.error ?? "error";
    throw new ApiError(status, code, data);
  }
  return data as T;
}

// ---- DTOs ----

export type GeoJsonPolygon = { type: "Polygon"; coordinates: number[][][] };
export type GeoJsonMultiPolygon = { type: "MultiPolygon"; coordinates: number[][][][] };
export type GeoJsonPoint = { type: "Point"; coordinates: [number, number] };
export type LatLng = { lat: number; lng: number };

export interface SessionGeo {
  boundary: GeoJsonPolygon;
  forbidden: GeoJsonMultiPolygon | null;
  assembly: LatLng;
}

export type SessionStatus = "lobby" | "countdown" | "live" | "breather" | "paused" | "gathering" | "ceremony" | "ended";

export interface CreatedSession {
  sessionId: string;
  pin: string;
  areaM2: number;
  hostToken: string;
}

export interface Joined {
  sessionId: string;
  playerId: string;
  nickname: string;
  status: SessionStatus;
  token: string;
  resumeCode: string;
}

export interface HostPlayer {
  id: string;
  nickname: string;
  role: string;
  status: string;
  checked_in: boolean;
  pos: LatLng | null;
  acc: number | null;
  fix_age_s: number | null;
  signal: "none" | "ok" | "uncertain" | "lost";
  geofence: 0 | 1 | 2 | 3;
  outside_m: number;
  forbidden: boolean;
  still_s: number | null;
  points: number;
  round_points: number;
  posts: number;
  badges: number;
  catches: number;
  times_caught: number;
  immune: boolean;
  distance_m: number;
  active_s: number;
}

/** Round clock as chase._round_view() returns it (server times). */
export interface RoundView {
  idx: number;
  count: number;
  mode: RoundMode;
  duration_s: number;
  phase_ends_at: string | null;
  frozen: boolean;
  qr: boolean;
  variant: "convert" | "swap" | null;
  /** Krympende sone on this round (0005). */
  zoned: boolean;
  /** Live/paused zone round: centre, radii, phase times — lib/rules/zone.ts computes the circle. */
  zone: ZoneState | null;
  next: PlanRound | null;
  /** 0009: a team round (flag, king, or "team": true). */
  team?: boolean;
  /** Flaggjakt (live/paused): owner / who is taking it are team numbers. */
  flags?: FlagView[] | null;
  /** Konge på haugen (live/paused). */
  hill?: HillView | null;
}

export interface FlagView {
  n: number;
  pos: LatLng;
  owner: number | null;
  cap: number | null;
  cap_since: string | null;
}

export interface HillView {
  no: number;
  pos: LatLng;
  r: number;
  at: string;
  next_at: string;
  holder: number | null;
  /** Players per team in the hill at the last count (index = team n − 1). */
  counts: number[];
  frozen_at: string | null;
}

export interface TeamInfo {
  n: number;
  name: string;
  color: string;
}

export interface TeamScore extends TeamInfo {
  id: string;
  points: number;
  members: number;
}

/** My team on the phone (chase._team_tick). Place + own score only (PLAN §0). */
export interface TeamView extends TeamInfo {
  points: number;
  rank: number;
  of: number;
  palette: TeamInfo[];
  /** Team rounds only. */
  mates?: { nickname: string; pos: LatLng }[];
  msgs?: { nickname: string; kind: TeamMsgKind; pos: LatLng | null; at: string; me: boolean }[];
}

export interface PostView {
  id: string;
  pos: LatLng;
  value: number;
  kind: "normal" | "golden";
  radius_m?: number;
  expires_at: string | null;
  claimed_by?: string | null;
}

export interface RoundSummary {
  round: number;
  points: number;
  posts: number;
  distance_m: number;
  active_s: number;
  move_pts: number;
  badges: Badge[];
}

export interface HostAlarm {
  id: string;
  player_id: string | null;
  nickname: string | null;
  kind: "sos" | "forbidden" | "outside" | "signal" | "speed";
  level: number;
  pos: LatLng | null;
  created_at: string;
  acked: boolean;
  resolved: boolean;
}

export interface Snapshot {
  server_now: string;
  status: SessionStatus;
  pin: string;
  round_idx: number;
  round_started_at: string | null;
  round: RoundView | null;
  plan: Plan;
  paused_at: string | null;
  gather_started_at: string | null;
  playlist_done: boolean;
  players: HostPlayer[];
  alarms: HostAlarm[];
  posts: PostView[] | null;
  qr_cards: { n: number; code: string; value: number }[] | null;
  geo: SessionGeo | null;
  referee_awards: string[];
  ceremony: CeremonyView | null;
  /** 0007: the current event (+ who reached it), what ⚡ may start now, the automatic switch. */
  event: HostEventView | null;
  event_kinds: EventKind[] | null;
  events_auto: boolean;
  events_every_s: number;
  mission_pending: { player_id: string; nickname: string }[];
  /** 0009: teams with the live score, and player id → team number. */
  teams: TeamScore[];
  team_of: Record<string, number>;
}

/** One event as the server keeps it (rounds.state.ev, 0007). Server times. */
export interface EventBase {
  no: number;
  kind: EventKind;
  at: string;
  ends_at: string;
  closes_at: string;
  done: boolean;
  target: LatLng | null;
  /** Mission: index into no.events.missions. */
  mission: number | null;
  /** 0010: the teacher's own mission text (wins over the built-in index). */
  mission_text?: string | null;
}

export interface HostEventView extends EventBase {
  done_at: string | null;
  entries: { player_id: string; nickname: string; state: "won" | "reached" | "pending" | "done"; place: number | null; points: number; powerup: Powerup | null }[];
}

/** The phone's event (chase._ev_tick). */
export interface EventView extends EventBase {
  frozen_at: string | null;
  dist_m: number | null;
  count: number;
  /** Sprint: places left. */
  left: number | null;
  me: { state: "won" | "reached" | "pending" | "done"; place: number | null; points: number; powerup: Powerup | null } | null;
}

export interface PowerView {
  inv: Powerup[];
  radar_until: string | null;
  turbo_until: string | null;
  decoy_until: string | null;
}

export interface TickView {
  server_now: string;
  status: SessionStatus;
  round_idx: number;
  round_started_at: string | null;
  round: RoundView | null;
  role: string;
  stats: { points: number; distance_m: number; active_s: number; posts: number; round_points: number; badges: Badge[]; steps?: number };
  /** 0012: an open question after a post (never the right answer). */
  quiz?: { no: number; q: string; a: string[]; until: string; right: number };
  posts: PostView[] | null;
  claim: { post_id: string; hits: number; need: number } | null;
  claimed: { post_id: string; value: number; kind: "normal" | "golden" } | null;
  lost: boolean;
  new_badges: Badge[];
  summary: RoundSummary | null;
  tag?: TagView;
  /** Zone round only: am I inside, points lost to the zone this round, phase bonuses. */
  zone?: { inside: boolean; dist_m: number; pen: number; hits: number };
  ceremony?: CeremonyView;
  /** 0007: current event and my power-ups. */
  event?: EventView | null;
  power?: PowerView;
  /** 0009: my team (once dealt). */
  team?: TeamView;
  safety: { geofence: 0 | 1 | 2 | 3; forbidden: boolean; outside_m: number; uncertain: boolean };
  sos: { id: string; acked: boolean } | null;
  gather: { assembly: LatLng; distance_m: number; checked_in: boolean } | null;
  messages: { id: number; at: string; text: string; private: boolean }[];
}

export interface PlayerBootstrap {
  sessionId: string;
  playerId: string;
  nickname: string;
  status: SessionStatus;
  teacherPhone: string | null;
  geo: SessionGeo;
  serverNow: string;
}

export type HostAction =
  | "start" | "next" | "extend" | "pause" | "resume" | "message" | "gather" | "end_gather"
  | "check_in" | "rename" | "kick" | "sit_out"
  | "ceremony_start" | "ceremony_next" | "ceremony_back" | "vote_again" | "adjust_points" | "set_role" | "referee_award"
  | "event_start" | "event_stop" | "mission_confirm" | "events_auto"
  | "teams_deal" | "team_set";

/** Ceremony as chase._ceremony_view() returns it (0006). Nicknames only, never ids. */
export interface CeremonyView {
  /** 0 = intro, k = k podiums revealed, total + 1 = «ditt beste»-kort. */
  step: number;
  total: number;
  spread: boolean;
  /** Team entries (Lagpall) carry the team colour; «me» = my team. */
  revealed: { cat: PodiumCat; entries: { place: number; nickname: string; value: number | null; me: boolean; color?: string | null }[] }[];
  best: BestCard | null;
  on_podium: boolean | null;
  voted: boolean | null;
  /** Teacher only: the anonymous count. */
  again: { yes: number; no: number; teacher: boolean | null } | null;
}

/** Smittejakt layer of the tick view (chase._mode_tick). Never other players' exact positions for prey. */
export interface TagView {
  variant: "convert" | "swap";
  code: string | null;
  immune_until: string | null;
  role_changed_at: string | null;
  hunters: number;
  prey: number;
  prey_near?: number;
  radar?: { pos: LatLng; age_s: number; stealth: boolean }[];
  hunter_near?: boolean;
  /** 0007: Mørkelegging — no radar right now. */
  blackout?: boolean;
  /** 0007: radar power-up — every opponent for a few seconds. */
  radar_live?: LatLng[];
}

export interface CatchResult {
  nickname: string;
  points: number;
  variant: "convert" | "swap";
  last: boolean;
  immuneUntil: string | null;
  newBadges: Badge[];
}

export interface QrResult {
  n: number;
  value: number;
  first: boolean;
  already: boolean;
  /** 0007: the scan confirmed a mission instead of claiming a post. */
  mission?: boolean;
  newBadges: Badge[];
}

// ---- Library + share links (0010) ----

export interface AreaGeo {
  boundary: GeoJsonPolygon;
  forbidden: GeoJsonMultiPolygon | null;
  assembly: LatLng;
  area_m2: number;
}
export interface LibArea extends AreaGeo {
  id: string;
  name: string;
  kind: "recent" | "saved";
  last_used_at: string;
}
export interface LibPlan {
  id: string;
  name: string;
  kind: "recent" | "saved";
  last_used_at: string;
  plan: Plan;
}
export interface LibPack {
  id: string;
  name: string;
  items: string[];
}
export interface LibShare {
  code: string;
  name: string;
  has_area: boolean;
  copies: number;
  created_at: string;
}
export interface Library {
  known: boolean;
  areas: LibArea[];
  plans: LibPlan[];
  packs: LibPack[];
  /** 0012: question packs. */
  quizzes: { id: string; name: string; items: QuizItem[] }[];
  shares: LibShare[];
}
export interface SharePreview {
  code: string;
  name: string;
  plan: Plan;
  area: AreaGeo | null;
  copies: number;
  created_at: string;
}
export type LibKind = "area" | "plan" | "pack" | "quiz";

const lib = <T,>(body: Record<string, unknown>) => post<T>("/api/library", body);

export const api = {
  library: {
    get: (teacherKey: string) => lib<Library>({ action: "get", teacherKey }),
    save: (teacherKey: string, kind: LibKind, name: string, data: unknown | null, id?: string | null) =>
      lib<{ id: string }>({ action: "save", teacherKey, kind, name, data, id: id ?? null }),
    remove: (teacherKey: string, kind: LibKind, id: string) => lib<Record<string, never>>({ action: "delete", teacherKey, kind, id }),
    share: (teacherKey: string, planId: string, areaId: string | null, name?: string) =>
      lib<{ code: string }>({ action: "share", teacherKey, planId, areaId, name: name ?? null }),
    revoke: (teacherKey: string, code: string) => lib<Record<string, never>>({ action: "revoke", teacherKey, code }),
    copy: (teacherKey: string, code: string) => lib<{ planId: string; areaId: string | null }>({ action: "copy", teacherKey, code }),
  },

  createSession: (body: {
    teacherKey?: string;
    boundary: GeoJsonPolygon;
    assembly: GeoJsonPoint;
    forbidden?: GeoJsonMultiPolygon | null;
    teacherPhone?: string | null;
    plan?: Plan;
    sim?: boolean;
  }) => post<CreatedSession>("/api/sessions", body),

  join: (pin: string, nickname: string, deviceId?: string) => post<Joined>("/api/join", { pin, nickname, deviceId }),
  resume: (pin: string, resumeCode: string) =>
    post<{ sessionId: string; playerId: string; nickname: string; token: string }>("/api/resume", { pin, resumeCode }),

  me: (sessionId: string, playerId: string, token: string) =>
    post<PlayerBootstrap>(`/api/s/${sessionId}/me`, { playerId, token }),
  tick: (sessionId: string, body: { playerId: string; token: string; lat: number; lng: number; acc: number; speed?: number | null; ts?: number; steps?: number }) =>
    post<TickView>(`/api/s/${sessionId}/tick`, body, 6000),
  catch: (sessionId: string, body: { playerId: string; token: string; code: string }) =>
    post<CatchResult>(`/api/s/${sessionId}/catch`, body, 8000),
  qr: (sessionId: string, body: { playerId: string; token: string; code: string }) =>
    post<QrResult>(`/api/s/${sessionId}/qr`, body, 8000),
  again: (sessionId: string, body: { playerId: string; token: string; yes: boolean }) =>
    post<{ already: boolean }>(`/api/s/${sessionId}/again`, body, 8000),
  powerup: (sessionId: string, body: { playerId: string; token: string; kind: Powerup }) =>
    post<{ kind: Powerup; until: string | null; newBadges: Badge[] }>(`/api/s/${sessionId}/event`, { ...body, action: "powerup" }, 8000),
  missionDone: (sessionId: string, body: { playerId: string; token: string }) =>
    post<{ state: "pending" | "done" | null }>(`/api/s/${sessionId}/event`, { ...body, action: "mission" }, 8000),
  quizAnswer: (sessionId: string, body: { playerId: string; token: string; choice: number }) =>
    post<{ right: boolean; answer: string | null; points: number; newBadges: Badge[] }>(`/api/s/${sessionId}/event`, { ...body, action: "quiz" }, 8000),
  teamMsg: (sessionId: string, body: { playerId: string; token: string; kind: TeamMsgKind }) =>
    post<{ kind: TeamMsgKind; at: string }>(`/api/s/${sessionId}/event`, { ...body, action: "team_msg" }, 8000),
  sos: (sessionId: string, body: { playerId: string; token: string; lat?: number; lng?: number }) =>
    post<{ alarmId: string; new: boolean }>(`/api/s/${sessionId}/sos`, body, 15000),

  snapshot: (sessionId: string, hostToken: string, geo = false) =>
    post<Snapshot>(`/api/s/${sessionId}/snapshot`, { hostToken, geo }, 6000),
  hostAction: (sessionId: string, hostToken: string, action: HostAction, payload?: Record<string, unknown>) =>
    post<{ status: SessionStatus; round: RoundView | null }>(`/api/s/${sessionId}/host`, { hostToken, action, payload }),
  ack: (sessionId: string, hostToken: string, alarmId: string) =>
    post<{ alarmId: string }>(`/api/s/${sessionId}/ack`, { hostToken, alarmId }),
  end: (sessionId: string, hostToken: string, force = false) =>
    post<{ already?: boolean }>(`/api/s/${sessionId}/end`, { hostToken, force }),
};
