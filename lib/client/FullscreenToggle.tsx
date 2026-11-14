"use client";

import { useEffect, useState } from "react";

import { no } from "@/lib/locale/no";

/** Small fixed-corner button to enter/exit fullscreen — for a distraction-free
 * projector or play view. Uses the Fullscreen API on the document root; the
 * click is the required user gesture. */
export function FullscreenToggle() {
  const [isFull, setIsFull] = useState(false);

  useEffect(() => {
    // setState lives in the event handler (not the effect body), so it tracks
    // real fullscreen changes without a render-time mismatch.
    const onChange = () => setIsFull(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggle = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch (e) {
      // Unsupported / blocked (rare on the target browsers) — fail quietly.
      console.warn("[fullscreen] request failed", e);
    }
  };

  return (
    <button
      className="ui-press grid size-12 place-items-center rounded-[var(--radius-ctl)] border border-line bg-ink-2 text-lg text-txt shadow-[var(--shadow-card)] hover:bg-ink-3"
      aria-label={isFull ? no.common.exitFullscreen : no.common.fullscreen}
      title={isFull ? no.common.exitFullscreen : no.common.fullscreen}
      onClick={toggle}
    >
      {isFull ? "🡼" : "⛶"}
    </button>
  );
}
