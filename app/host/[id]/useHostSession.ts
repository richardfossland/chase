"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, api, type HostAction, type SessionGeo, type Snapshot } from "@/lib/client/api";
import { audioReady, playBuzzer, playSiren } from "@/lib/client/sound";
import { useChannel } from "@/lib/client/useChannel";
import { useTabHidden } from "@/lib/client/useTabHidden";
import { channels } from "@/lib/realtime";

const POLL_MS = 2000; // PLAN §9.2
const HIDDEN_POLL_MS = 10000; // keep healing in the background, slower
const SIREN_EVERY_MS = 4000;

export interface HostSession {
  sessionId: string;
  snap: Snapshot | null;
  geo: SessionGeo | null;
  error: string | null;
  refresh: () => Promise<void>;
  act: (action: HostAction, payload?: Record<string, unknown>) => Promise<boolean>;
  ack: (alarmId: string) => Promise<void>;
  end: (force: boolean) => Promise<{ ok: true } | { ok: false; missing: { id: string; nickname: string }[] }>;
}

/**
 * Teacher state: snapshot poll every 2 s + Realtime hints for instant refetch.
 * Safety (CLAUDE.md rule 4): an unacked SOS sirens every few seconds until
 * acked; any other new alarm buzzes once. Nothing here can mute an alarm.
 */
export function useHostSession(sessionId: string, token: string | null): HostSession {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [geo, setGeo] = useState<SessionGeo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hidden = useTabHidden();
  const inflight = useRef(false);
  const needGeo = useRef(true);
  const seenAlarms = useRef<Set<string> | null>(null);

  const refresh = useCallback(async () => {
    if (!token || inflight.current) return;
    inflight.current = true;
    try {
      const s = await api.snapshot(sessionId, token, needGeo.current);
      if (s.geo) {
        setGeo(s.geo);
        needGeo.current = false;
      }
      setSnap(s);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.code : "network");
    } finally {
      inflight.current = false;
    }
  }, [sessionId, token]);

  useEffect(() => {
    if (!token) return;
    const first = setTimeout(refresh, 0);
    const iv = setInterval(refresh, hidden ? HIDDEN_POLL_MS : POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(iv);
    };
  }, [token, hidden, refresh]);

  const onHint = useCallback(() => void refresh(), [refresh]);
  useChannel(token ? channels.host(sessionId) : null, onHint);

  // New alarm → buzz once (not for the ones already there when the panel opened).
  useEffect(() => {
    if (!snap) return;
    const ids = new Set(snap.alarms.filter((a) => !a.acked).map((a) => a.id));
    if (seenAlarms.current) {
      const fresh = [...ids].some((id) => !seenAlarms.current!.has(id));
      if (fresh) {
        playBuzzer();
        try {
          navigator.vibrate?.([300, 100, 300]);
        } catch {
          /* no vibration */
        }
      }
    }
    seenAlarms.current = ids;
  }, [snap]);

  // Unacked SOS → siren until acked.
  const sosOpen = !!snap?.alarms.some((a) => a.kind === "sos" && !a.acked);
  useEffect(() => {
    if (!sosOpen) return;
    const ring = () => {
      if (audioReady()) playSiren();
    };
    ring();
    const iv = setInterval(ring, SIREN_EVERY_MS);
    return () => clearInterval(iv);
  }, [sosOpen]);

  const act = useCallback(
    async (action: HostAction, payload?: Record<string, unknown>) => {
      if (!token) return false;
      try {
        await api.hostAction(sessionId, token, action, payload);
        void refresh();
        return true;
      } catch (e) {
        setError(e instanceof ApiError ? e.code : "network");
        return false;
      }
    },
    [sessionId, token, refresh],
  );

  const ack = useCallback(
    async (alarmId: string) => {
      if (!token) return;
      try {
        await api.ack(sessionId, token, alarmId);
      } catch (e) {
        setError(e instanceof ApiError ? e.code : "network");
      }
      void refresh();
    },
    [sessionId, token, refresh],
  );

  const end = useCallback(
    async (force: boolean) => {
      if (!token) return { ok: false as const, missing: [] };
      try {
        await api.end(sessionId, token, force);
        void refresh();
        return { ok: true as const };
      } catch (e) {
        if (e instanceof ApiError && e.code === "missing") {
          const missing = (e.payload as { missing?: { id: string; nickname: string }[] })?.missing ?? [];
          return { ok: false as const, missing };
        }
        setError(e instanceof ApiError ? e.code : "network");
        return { ok: false as const, missing: [] };
      }
    },
    [sessionId, token, refresh],
  );

  return { sessionId, snap, geo, error, refresh, act, ack, end };
}
