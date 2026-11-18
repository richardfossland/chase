"use client";

// Snus and Termometer (0017): two buttons for hunter and prey in a tag round.
// The server decides the answer and the cooldown; this only shows it big for
// five seconds (principle 6) and counts down the cooldown. No position is ever
// received or shown here.

import { useCallback, useEffect, useState } from "react";
import { ApiError, api, type HotColdResult } from "@/lib/client/api";
import { cue } from "@/lib/client/feedback";
import { unlockAudio } from "@/lib/client/sound";
import { no } from "@/lib/locale/no";
import { HOTCOLD, cooldownLeftS, hotColdCheck, type HotColdKind } from "@/lib/rules/hotcold";
import type { RoundMode } from "@/lib/rules/game";

const h = no.hotcold;
const SHOW_MS = 5000;

function answerOf(r: HotColdResult): { text: string; sub: string; good: boolean | null } {
  if (r.kind === "sniff") {
    const m = r.rangeM ?? HOTCOLD.sniff_m;
    return r.near ? { text: h.yes, sub: h.near(m), good: true } : { text: h.no, sub: h.far(m), good: false };
  }
  if (r.trend === "warmer") return { text: h.warmer, sub: h.warmerSub, good: true };
  if (r.trend === "colder") return { text: h.colder, sub: h.colderSub, good: false };
  return { text: h.same, sub: h.sameSub, good: null };
}

export function HotColdBar({
  sessionId,
  playerId,
  token,
  mode,
  role,
  now,
}: {
  sessionId: string;
  playerId: string;
  token: string;
  mode: RoundMode | null | undefined;
  role: string | undefined;
  now: number;
}) {
  const [busy, setBusy] = useState(false);
  const [usedAt, setUsedAt] = useState<number | null>(null);
  const [shown, setShown] = useState<{ id: number; text: string; sub: string; good: boolean | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!shown) return;
    const id = setTimeout(() => setShown(null), SHOW_MS);
    return () => clearTimeout(id);
  }, [shown]);
  useEffect(() => {
    if (!err) return;
    const id = setTimeout(() => setErr(null), 3000);
    return () => clearTimeout(id);
  }, [err]);

  const use = useCallback(
    async (kind: HotColdKind) => {
      if (busy) return;
      setBusy(true);
      unlockAudio();
      try {
        const r = await api.hotcold(sessionId, { playerId, token, kind });
        setUsedAt(Date.now());
        const a = answerOf(r);
        cue(a.good === false ? "lost" : "claim");
        setShown({ id: Date.now(), ...a });
      } catch (e) {
        const code = e instanceof ApiError ? e.code : "";
        if (code === "cooldown" && e instanceof ApiError) {
          const w = Number((e.payload as { wait_s?: number } | null)?.wait_s);
          if (Number.isFinite(w)) setUsedAt(Date.now() - (HOTCOLD.cooldown_s - w) * 1000);
        }
        cue("lost");
        setErr(h.errors[code] ?? no.play.qrError);
      } finally {
        setBusy(false);
      }
    },
    [busy, sessionId, playerId, token],
  );

  if (hotColdCheck("sniff", mode, role ?? "neutral") !== null) return null;
  const left = cooldownLeftS(usedAt, now);
  const kinds: HotColdKind[] = ["sniff", "thermo"];
  return (
    <>
      <div className="m-rise-in flex flex-wrap items-center gap-2 px-4 pb-2" data-testid="hotcold-bar">
        {kinds.map((k) => (
          <button
            key={k}
            disabled={busy || left > 0}
            title={k === "sniff" ? h.sniffHelp(HOTCOLD.sniff_m) : h.thermoHelp}
            className="ui-press flex min-h-12 items-center gap-2 rounded-full border-2 border-white/70 bg-black/45 px-4 text-base font-black text-white disabled:opacity-40"
            onClick={() => void use(k)}
            data-testid={`hotcold-${k}`}
          >
            {h[k]}
            {left > 0 && <span className="text-sm font-bold opacity-80">{h.wait(left)}</span>}
          </button>
        ))}
        {err && (
          <span className="rounded-full bg-black/55 px-3 py-2 text-sm font-black text-white" role="alert">
            {err}
          </span>
        )}
      </div>
      {shown && (
        <div
          key={shown.id}
          className={`pointer-events-none fixed inset-0 z-40 flex flex-col items-center justify-center text-center text-white ${
            shown.good === true ? "bg-ok/85" : shown.good === false ? "bg-black/75" : "bg-black/60"
          }`}
          role="status"
          data-testid="hotcold-answer"
        >
          <p className="m-pop px-4 text-7xl font-black">{shown.text}</p>
          <p className="mt-2 px-4 text-2xl font-black">{shown.sub}</p>
        </div>
      )}
    </>
  );
}
