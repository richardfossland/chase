"use client";

// Step counter (fase 7, PLAN §… «eventuell DeviceMotion/skritteller»): a small
// peak detector on the acceleration magnitude (incl. gravity). Opt-in; iOS
// needs DeviceMotionEvent.requestPermission() from a tap («Jeg er klar»).
// The server caps what it accepts (chase._steps_accept, 4 steps/s).

import { useCallback, useEffect, useRef } from "react";

const G = 9.81;
const HIGH = G + 1.5; // a step's push-off peak
const LOW = G + 0.5; // must drop below this before the next step counts
const MIN_GAP_S = 0.25; // ≤ 4 steps/s

export class StepDetector {
  private armed = true;
  private lastStepT = -Infinity;
  steps = 0;
  /** Feed one sample (m/s², incl. gravity) at time t (s). Returns true on a new step. */
  push(mag: number, t: number): boolean {
    if (this.armed && mag > HIGH && t - this.lastStepT >= MIN_GAP_S) {
      this.armed = false;
      this.lastStepT = t;
      this.steps++;
      return true;
    }
    if (!this.armed && mag < LOW) this.armed = true;
    return false;
  }
}

/** Steps in a recorded series of magnitudes at `hz` samples per second (tests, sim). */
export function countSteps(mags: number[], hz: number): number {
  const d = new StepDetector();
  mags.forEach((m, i) => d.push(m, i / hz));
  return d.steps;
}

type MotionCtor = { requestPermission?: () => Promise<"granted" | "denied"> };

/** Ask for motion access (must run inside a tap on iOS). true = we may listen. */
export async function requestMotion(): Promise<boolean> {
  if (typeof window === "undefined" || !("DeviceMotionEvent" in window)) return false;
  const C = window.DeviceMotionEvent as unknown as MotionCtor;
  if (typeof C.requestPermission !== "function") return true; // Android / desktop: no prompt
  try {
    return (await C.requestPermission()) === "granted";
  } catch {
    return false;
  }
}

/** Counts steps while enabled; take() returns the steps since the last take(). */
export function useStepCounter(enabled: boolean) {
  const det = useRef(new StepDetector());
  const taken = useRef(0);
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const t0 = performance.now();
    const on = (e: DeviceMotionEvent) => {
      const a = e.accelerationIncludingGravity;
      if (!a || a.x == null || a.y == null || a.z == null) return;
      det.current.push(Math.hypot(a.x, a.y, a.z), (performance.now() - t0) / 1000);
    };
    window.addEventListener("devicemotion", on);
    return () => window.removeEventListener("devicemotion", on);
  }, [enabled]);
  return useCallback(() => {
    const n = det.current.steps - taken.current;
    taken.current = det.current.steps;
    return n;
  }, []);
}
