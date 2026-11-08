"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// GPS for the player client (PLAN §9.5). One source of truth for the current
// fix, whether it comes from navigator.geolocation or the simulator
// (`?simgps=1`, PLAN §11.1). Positions stay in memory only — never stored,
// never put in URLs.

export interface Fix {
  lat: number;
  lng: number;
  acc: number;
  speed: number | null;
  at: number; // Date.now() when received
}

const REFRESH_AFTER_MS = 10_000;

export type GpsError = "denied" | "unavailable" | "unsupported" | null;

export interface GpsState {
  fix: Fix | null;
  error: GpsError;
  /** Start watching. Must be called from a user gesture the first time (iOS). */
  start: () => void;
  started: boolean;
}

/** Real device GPS. Restarts the watch when the page becomes visible again
 * (iOS stops GPS while the screen is locked). */
export function useDeviceGps(): GpsState {
  const [fix, setFix] = useState<Fix | null>(null);
  const [error, setError] = useState<GpsError>(null);
  const [started, setStarted] = useState(false);
  const watchId = useRef<number | null>(null);

  const watch = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setError("unsupported");
      return;
    }
    if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
    watchId.current = navigator.geolocation.watchPosition(
      (p) => {
        setError(null);
        setFix({
          lat: p.coords.latitude,
          lng: p.coords.longitude,
          acc: p.coords.accuracy,
          speed: p.coords.speed ?? null,
          at: Date.now(),
        });
      },
      (e) => setError(e.code === e.PERMISSION_DENIED ? "denied" : "unavailable"),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
    );
  }, []);

  const start = useCallback(() => {
    setStarted(true);
    watch();
  }, [watch]);

  // iOS may stop emitting while the phone is still. Ask for a fresh fix when
  // the last one is getting old, so a pupil standing still is not mistaken
  // for signal loss (and a really lost signal still shows as lost).
  const lastAt = useRef(0);
  useEffect(() => {
    lastAt.current = fix?.at ?? 0;
  }, [fix]);

  useEffect(() => {
    if (!started) return;
    const onVis = () => {
      if (document.visibilityState === "visible") watch();
    };
    const refresh = setInterval(() => {
      if (document.visibilityState !== "visible" || Date.now() - lastAt.current < REFRESH_AFTER_MS) return;
      navigator.geolocation?.getCurrentPosition(
        (p) =>
          setFix({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, speed: p.coords.speed ?? null, at: Date.now() }),
        () => {},
        { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 },
      );
    }, 5000);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(refresh);
      document.removeEventListener("visibilitychange", onVis);
      if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
      watchId.current = null;
    };
  }, [started, watch]);

  return { fix, error, start, started };
}

export interface SimControls {
  move: (eastM: number, northM: number) => void;
  setAcc: (m: number) => void;
  setSignal: (on: boolean) => void;
  acc: number;
  signal: boolean;
}

const M_PER_DEG_LAT = 111_320;

/** Simulated GPS: a position you move with buttons/WASD, adjustable accuracy
 * and a signal switch. Emits a fix every second like watchPosition does. */
export function useSimGps(origin: { lat: number; lng: number } | null): GpsState & { sim: SimControls } {
  const [pos, setPos] = useState<{ lat: number; lng: number } | null>(null);
  const [acc, setAcc] = useState(6);
  const [signal, setSignal] = useState(true);
  const [started, setStarted] = useState(false);
  const [fix, setFix] = useState<Fix | null>(null);
  const last = useRef<{ lat: number; lng: number; at: number } | null>(null);

  const here = pos ?? origin;

  useEffect(() => {
    if (!started || !signal || !here) return;
    const emit = () => {
      const now = Date.now();
      const prev = last.current;
      let speed: number | null = null;
      if (prev) {
        const dy = (here.lat - prev.lat) * M_PER_DEG_LAT;
        const dx = (here.lng - prev.lng) * M_PER_DEG_LAT * Math.cos((here.lat * Math.PI) / 180);
        speed = Math.hypot(dx, dy) / Math.max(0.001, (now - prev.at) / 1000);
      }
      last.current = { ...here, at: now };
      setFix({ lat: here.lat, lng: here.lng, acc, speed, at: now });
    };
    const first = setTimeout(emit, 0);
    const iv = setInterval(emit, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(iv);
    };
  }, [started, signal, here, acc]);

  const move = useCallback(
    (eastM: number, northM: number) => {
      setPos((p) => {
        const base = p ?? origin;
        if (!base) return p;
        return {
          lat: base.lat + northM / M_PER_DEG_LAT,
          lng: base.lng + eastM / (M_PER_DEG_LAT * Math.cos((base.lat * Math.PI) / 180)),
        };
      });
    },
    [origin],
  );

  return {
    fix: signal ? fix : null,
    error: null,
    start: () => setStarted(true),
    started,
    sim: { move, setAcc, setSignal, acc, signal },
  };
}

/** Screen Wake Lock during play (re-acquired when the page is visible again). */
export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || typeof navigator === "undefined" || !("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    const acquire = async () => {
      try {
        const l = await navigator.wakeLock.request("screen");
        if (cancelled) void l.release();
        else lock = l;
      } catch {
        /* denied or unsupported: the round structure tolerates it */
      }
    };
    const onVis = () => {
      if (document.visibilityState === "visible") void acquire();
    };
    void acquire();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVis);
      void lock?.release();
    };
  }, [active]);
}

export function vibrate(pattern: number | number[]) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* iOS: no vibration — sound + flash are primary */
  }
}
