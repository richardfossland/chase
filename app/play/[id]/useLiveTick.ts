"use client";

// The phone's tick loop (PLAN §9.2): a fix every 2 s in fast phases / 10 s when
// calm. Over the session room socket when the bootstrap offers one and it is
// ready, otherwise HTTP (api.tick) exactly as before. Safety first: whenever the
// socket is not ready the HTTP path takes over at once.

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";

import { ApiError, api, type TickView } from "@/lib/client/api";
import type { Fix } from "@/lib/client/gps";
import { LiveSocket, fixDelayMs } from "@/lib/client/live";
import { useChannel } from "@/lib/client/useChannel";
import { CLOSE, type ServerMsg } from "@/lib/live/protocol";
import { channels } from "@/lib/realtime";

const FAST_MS = 2000; // active round / gathering (PLAN §9.2)
const SLOW_MS = 10000; // lobby / pause
const STALE_FIX_MS = 15000; // never send an old fix as if it were current

export interface LiveTickOpts {
  sessionId: string;
  playerId: string;
  token: string;
  /** Bootstrap `live`; null = HTTP transport. */
  live: { path: string } | null;
  ready: boolean;
  ended: boolean;
  kicked: boolean;
  fast: boolean;
  hasView: boolean;
  fixRef: MutableRefObject<Fix | null>;
  hasFix: boolean;
  takeSteps: () => number;
  onView: (v: TickView) => void;
  onEnded: () => void;
  onKicked: () => void;
}

export function useLiveTick(o: LiveTickOpts): { tickNow: () => void } {
  const { sessionId, playerId, token, live, ready, ended, kicked, fast, hasView, fixRef, hasFix, takeSteps } = o;
  const cb = useRef(o);
  useEffect(() => {
    cb.current = o;
  });

  const inflight = useRef(false);
  const sock = useRef<LiveSocket | null>(null);
  const lastSent = useRef<number | null>(null);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [wsReady, setWsReady] = useState(false);
  const tickRef = useRef<() => void>(() => {});

  const httpTick = useCallback(async () => {
    const f = fixRef.current;
    if (!f || inflight.current || Date.now() - f.at > STALE_FIX_MS) return;
    inflight.current = true;
    try {
      const v = await api.tick(sessionId, {
        playerId,
        token,
        lat: f.lat,
        lng: f.lng,
        acc: f.acc,
        speed: f.speed,
        ts: Date.now(), // send time: orders requests; the same fix may be re-sent while standing still
        steps: takeSteps() || undefined,
      });
      cb.current.onView(v);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "";
      if (code === "ended") cb.current.onEnded();
      else if (code === "kicked") cb.current.onKicked();
      // network/timeout/stale: the next tick tries again
    } finally {
      inflight.current = false;
    }
  }, [sessionId, playerId, token, fixRef, takeSteps]);

  const wsSend = useCallback((): boolean => {
    const s = sock.current;
    if (!s || s.state !== "ready") return false;
    const f = fixRef.current;
    if (!f || Date.now() - f.at > STALE_FIX_MS) return true; // nothing fresh to say; not a transport failure
    const wait = fixDelayMs(Date.now(), lastSent.current);
    if (wait > 0) {
      // Too soon after the last fix: send one at the earliest allowed moment.
      if (!pending.current) {
        pending.current = setTimeout(() => {
          pending.current = null;
          tickRef.current();
        }, wait);
      }
      return true;
    }
    const ok = s.send({
      lat: f.lat,
      lng: f.lng,
      acc: f.acc,
      speed: f.speed,
      ts: Date.now(),
      steps: takeSteps() || undefined,
    });
    if (ok) lastSent.current = Date.now();
    return ok;
  }, [fixRef, takeSteps]);

  const tickNow = useCallback(() => {
    if (wsSend()) return;
    void httpTick();
  }, [wsSend, httpTick]);
  useEffect(() => {
    tickRef.current = tickNow;
  });

  // The socket itself.
  const wanted = !!live && ready && !ended && !kicked;
  const path = live?.path ?? null;
  useEffect(() => {
    if (!wanted || !path) return;
    const onMsg = (m: ServerMsg) => {
      if (m.t === "view") cb.current.onView(m.v as unknown as TickView);
      else if (m.t === "hint") tickRef.current();
      else if (m.t === "err") {
        if (m.error === "ended") cb.current.onEnded();
        else if (m.error === "kicked") cb.current.onKicked();
      }
    };
    const s = new LiveSocket({
      path,
      auth: { t: "auth", role: "player", playerId, token },
      onMsg,
      onState: (state, d) => {
        setWsReady(state === "ready");
        if (state === "ready") {
          tickRef.current(); // first fix over the socket right away
          return;
        }
        if (d?.code === CLOSE.ended) cb.current.onEnded();
        else if (d?.code === CLOSE.kicked) cb.current.onKicked();
        // Not ready any more (dropped, not_found, auth, disabled): HTTP takes over at once.
        else if (state === "closed" || state === "disabled") tickRef.current();
      },
    });
    sock.current = s;
    return () => {
      s.close();
      if (sock.current === s) sock.current = null;
      if (pending.current) clearTimeout(pending.current);
      pending.current = null;
      setWsReady(false);
    };
  }, [wanted, path, playerId, token]);

  useEffect(() => {
    if (!ready || ended || kicked) return;
    const first = setTimeout(tickNow, 0);
    const iv = setInterval(tickNow, fast ? FAST_MS : SLOW_MS);
    return () => {
      clearTimeout(first);
      clearInterval(iv);
    };
  }, [ready, ended, kicked, fast, tickNow]);

  // First fix after «Jeg er klar»: report at once instead of waiting a full interval.
  useEffect(() => {
    if (ready && hasFix && !hasView) tickNow();
  }, [ready, hasFix, hasView, tickNow]);

  // Supabase hints only while we are on HTTP; the socket pushes its own.
  const onHint = useCallback(() => tickNow(), [tickNow]);
  const viaChannel = ready && !wsReady;
  useChannel(viaChannel ? channels.all(sessionId) : null, onHint);
  useChannel(viaChannel ? channels.player(sessionId, playerId) : null, onHint);

  return { tickNow };
}
