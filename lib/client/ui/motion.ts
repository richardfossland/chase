"use client";

import { useEffect, useRef, useState } from "react";

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Keeps a value mounted for `exitMs` after it goes null/false so an exit
 * animation can play. Returns the value to render and whether it is leaving.
 * Never use for safety UI (SOS / alarms): those mount and unmount instantly. */
export function usePresence<T>(value: T | null | undefined | false, exitMs = 220): { item: T | null; leaving: boolean } {
  const [last, setLast] = useState<T | null>(value || null);
  const [gone, setGone] = useState(!value);
  // Derive during render (no effect): remember the latest truthy value.
  if (value && last !== value) setLast(value);
  if (value && gone) setGone(false);
  useEffect(() => {
    if (value) return;
    const id = setTimeout(() => setGone(true), prefersReducedMotion() ? 0 : exitMs);
    return () => clearTimeout(id);
  }, [value, exitMs]);
  if (value) return { item: value, leaving: false };
  return gone ? { item: null, leaving: false } : { item: last, leaving: last !== null };
}

/** Animates a number towards `target` (points ticking up). Display only: the
 * server value is the truth and the hook always lands exactly on it. */
export function useCountUp(target: number, ms = 600): number {
  const [shown, setShown] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const start = from.current;
    if (start === target) return;
    const dur = prefersReducedMotion() ? 0 : ms;
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const k = dur <= 0 ? 1 : Math.min(1, (t - t0) / dur);
      const eased = 1 - Math.pow(1 - k, 3);
      const v = Math.round(start + (target - start) * eased);
      from.current = v;
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return shown;
}

/** Returns a key that changes whenever `value` changes, to retrigger a CSS
 * animation (e.g. className="m-bump" key={bumpKey}). */
export function useChangeKey(value: unknown): number {
  const [prev, setPrev] = useState(value);
  const [key, setKey] = useState(0);
  if (prev !== value) {
    setPrev(value);
    setKey(key + 1);
  }
  return key;
}
