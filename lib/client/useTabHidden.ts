"use client";

import { useEffect, useState } from "react";

/** True while this tab is in the background (Page Visibility API). Used to
 * slow a poll's cadence instead of skipping it while backgrounded, so a tab
 * whose channel silently died still heals within a bounded time even if it is
 * never foregrounded again (a projector tab left on another workspace). Safe
 * during SSR (no `document` → false; corrected on mount). */
export function useTabHidden(): boolean {
  const [hidden, setHidden] = useState(
    () => typeof document !== "undefined" && document.visibilityState === "hidden",
  );
  useEffect(() => {
    const onChange = () => setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return hidden;
}
