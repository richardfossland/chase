"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, api, type HostAction, type SessionGeo, type Snapshot } from "@/lib/client/api";
import { audioReady, playBuzzer, playSiren } from "@/lib/client/sound";
import { LiveSocket, hostPollDue, mergeHostPush, olderSnapshot } from "@/lib/client/live";
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
  /** Like act, but hands back the error code (null = done) for messages in a sheet. */
  tryAct: (action: HostAction, payload?: Record<string, unknown>) => Promise<string | null>;
  ack: (alarmId: string) => Promise<void>;
  setVoice: (on: boolean) => Promise<void>;
  /** Et setVoice-kall pågår: bryteren skal være deaktivert. */
  voiceBusy: boolean;
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
  const lastHttpAt = useRef<number | null>(null);
  const lastPushAt = useRef<number | null>(null);
  const wsReady = useRef(false);

  const refresh = useCallback(async () => {
    if (!token || inflight.current) return;
    inflight.current = true;
    lastHttpAt.current = Date.now();
    try {
      const s = await api.snapshot(sessionId, token, needGeo.current);
      if (s.geo) {
        setGeo(s.geo);
        needGeo.current = false;
      }
      // Keep `live` from the HTTP answer even when the rest is older than a push (kill switch).
      setSnap((prev) => (prev && olderSnapshot(prev, s) ? { ...prev, live: s.live } : s));
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
    // With the socket pushing, HTTP is only a 10 s watchdog; otherwise poll as before.
    const poll = () => {
      if (hostPollDue({ wsReady: wsReady.current, lastPushAt: lastPushAt.current, lastHttpAt: lastHttpAt.current, now: Date.now() })) void refresh();
    };
    const iv = setInterval(poll, hidden ? HIDDEN_POLL_MS : POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(iv);
    };
  }, [token, hidden, refresh]);

  // Session room socket (when the snapshot offers one): pushed host views + alarm nudges.
  const livePath = snap?.live?.path ?? null;
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  });
  useEffect(() => {
    if (!token || !livePath) return;
    const s = new LiveSocket({
      path: livePath,
      auth: { t: "auth", role: "host", hostToken: token },
      onMsg: (m) => {
        if (m.t === "host") {
          lastPushAt.current = Date.now();
          setSnap((prev) => (prev && !olderSnapshot(prev, m.v) ? mergeHostPush(prev, m.v) : prev));
          setError(null);
        } else if (m.t === "alarm") {
          void refreshRef.current();
        }
      },
      onState: (state) => {
        wsReady.current = state === "ready";
        if (state !== "ready") void refreshRef.current(); // back to HTTP at once
      },
    });
    return () => {
      s.close();
      wsReady.current = false;
      lastPushAt.current = null;
    };
  }, [token, livePath]);

  const onHint = useCallback(() => void refresh(), [refresh]);
  useChannel(token ? channels.host(sessionId) : null, onHint);

  // New alarm: buzz once (not for the ones already there when the panel opened).
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

  // Unacked SOS: siren until acked.
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

  const tryAct = useCallback(
    async (action: HostAction, payload?: Record<string, unknown>) => {
      if (!token) return "auth";
      try {
        await api.hostAction(sessionId, token, action, payload);
        void refresh();
        return null;
      } catch (e) {
        return e instanceof ApiError ? e.code : "network";
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

  const [voiceBusy, setVoiceBusy] = useState(false);
  const setVoice = useCallback(
    async (on: boolean) => {
      if (!token || voiceBusy) return;
      setVoiceBusy(true);
      try {
        await api.setVoice(sessionId, token, on);
      } catch (e) {
        setError(e instanceof ApiError ? e.code : "network");
      }
      await refresh();
      setVoiceBusy(false);
    },
    [sessionId, token, refresh, voiceBusy],
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

  return { sessionId, snap, geo, error, refresh, act, tryAct, ack, setVoice, voiceBusy, end };
}
