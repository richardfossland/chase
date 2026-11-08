"use client";

// Typed fetch wrappers around the Chase API (pattern from Sjakk's lib/client/api.ts).
// Tokens and positions travel only in POST bodies — never in URLs.

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
  distance_m: number;
  active_s: number;
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
  paused_at: string | null;
  gather_started_at: string | null;
  players: HostPlayer[];
  alarms: HostAlarm[];
  geo: SessionGeo | null;
}

export interface TickView {
  server_now: string;
  status: SessionStatus;
  round_idx: number;
  round_started_at: string | null;
  role: string;
  stats: { points: number; distance_m: number; active_s: number };
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

export type HostAction = "start" | "pause" | "resume" | "message" | "gather" | "end_gather" | "check_in" | "rename" | "kick" | "sit_out";

export const api = {
  createSession: (body: {
    teacherKey?: string;
    boundary: GeoJsonPolygon;
    assembly: GeoJsonPoint;
    forbidden?: GeoJsonMultiPolygon | null;
    teacherPhone?: string | null;
    plan?: { rounds: { mode: "free"; duration_s: number }[] };
    sim?: boolean;
  }) => post<CreatedSession>("/api/sessions", body),

  join: (pin: string, nickname: string, deviceId?: string) => post<Joined>("/api/join", { pin, nickname, deviceId }),
  resume: (pin: string, resumeCode: string) =>
    post<{ sessionId: string; playerId: string; nickname: string; token: string }>("/api/resume", { pin, resumeCode }),

  me: (sessionId: string, playerId: string, token: string) =>
    post<PlayerBootstrap>(`/api/s/${sessionId}/me`, { playerId, token }),
  tick: (sessionId: string, body: { playerId: string; token: string; lat: number; lng: number; acc: number; speed?: number | null; ts?: number }) =>
    post<TickView>(`/api/s/${sessionId}/tick`, body, 6000),
  sos: (sessionId: string, body: { playerId: string; token: string; lat?: number; lng?: number }) =>
    post<{ alarmId: string; new: boolean }>(`/api/s/${sessionId}/sos`, body, 15000),

  snapshot: (sessionId: string, hostToken: string, geo = false) =>
    post<Snapshot>(`/api/s/${sessionId}/snapshot`, { hostToken, geo }, 6000),
  hostAction: (sessionId: string, hostToken: string, action: HostAction, payload?: Record<string, unknown>) =>
    post<{ status: SessionStatus }>(`/api/s/${sessionId}/host`, { hostToken, action, payload }),
  ack: (sessionId: string, hostToken: string, alarmId: string) =>
    post<{ alarmId: string }>(`/api/s/${sessionId}/ack`, { hostToken, alarmId }),
  end: (sessionId: string, hostToken: string, force = false) =>
    post<{ already?: boolean }>(`/api/s/${sessionId}/end`, { hostToken, force }),
};
