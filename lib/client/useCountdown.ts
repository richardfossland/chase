"use client";

import { useEffect, useState } from "react";

/** Ticking countdown to `endMs` (epoch). Returns remaining ms and whether it
 * has expired. Returns nulls when there is no deadline. */
export function useCountdown(endMs: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (endMs == null) return { remainingMs: null as number | null, expired: false };
  const remainingMs = Math.max(0, endMs - now);
  return { remainingMs, expired: remainingMs === 0 };
}

/** Format ms as m:ss. */
export function fmt(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
