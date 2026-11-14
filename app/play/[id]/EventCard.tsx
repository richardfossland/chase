"use client";

// Phone side of phase 4 (0007): the event card (what to do, countdown,
// direction to the target, my result) and the power-up row. The server
// decides everything; this only shows it and sends one-tap requests.

import type { EventView, PowerView, RoundView } from "@/lib/client/api";
import { no } from "@/lib/locale/no";
import { bearing, haversine } from "@/lib/geo";
import { formatClock } from "@/lib/rules/game";
import { powerupCheck, type Powerup } from "@/lib/rules/events";
import type { Fix } from "@/lib/client/gps";
import { useTurn } from "./useTurn";

const e = no.events;

/** Seconds left of the event from server time; stands still while paused. */
export function eventLeftS(ev: EventView, offsetMs: number, nowMs: number): number {
  const end = Date.parse(ev.ends_at);
  const ref = ev.frozen_at ? Date.parse(ev.frozen_at) : nowMs + offsetMs;
  return Math.max(0, Math.ceil((end - ref) / 1000));
}

export function EventStrip({
  ev,
  fix,
  offsetMs,
  now,
  qr,
  pendingLocal,
  onDone,
  onScan,
}: {
  ev: EventView;
  fix: Fix | null;
  offsetMs: number;
  now: number;
  qr: boolean;
  pendingLocal: boolean;
  onDone: () => void;
  onScan: () => void;
}) {
  const left = eventLeftS(ev, offsetMs, now);
  const over = ev.done || left === 0;
  const me = ev.me;
  // Live direction from my own fix (the server's dist_m is from the last tick).
  const dir = ev.target && fix && !over && !me
    ? { m: Math.round(haversine([fix.lng, fix.lat], [ev.target.lng, ev.target.lat])), deg: bearing([fix.lng, fix.lat], [ev.target.lng, ev.target.lat]) }
    : null;
  const turn = useTurn(dir?.deg ?? 0);

  let line: string | null = null;
  if (me?.state === "won") line = e.won(me.place ?? 0, me.points);
  else if (me?.state === "reached") line = e.reached(me.points);
  else if (me?.state === "done") line = e.confirmed(me.points);
  else if (me?.state === "pending" || pendingLocal) line = e.pending;
  else if (over) line = null;   // «Hendelsen er over» on the right says it
  else if (ev.kind === "mission" && ev.mission_text) line = ev.mission_text;
  else if (ev.kind === "mission" && ev.mission !== null) line = e.missions[ev.mission];
  else line = e.phoneDesc[ev.kind] ?? null;

  return (
    <div className="m-drop-in mx-4 mb-2 rounded-xl border-2 border-gold bg-black/50 px-3 py-2 text-white shadow-[var(--shadow-card)]" role="status" data-testid="event-strip">
      <div className="flex items-center gap-3">
        {dir && (
          <span className="p-compass inline-block text-3xl leading-none" style={{ transform: `rotate(${turn}deg)` }} aria-hidden>
            ↑
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-black uppercase tracking-wide text-gold">{e.kinds[ev.kind]}</p>
          {line && (
            <p key={line} className="m-rise-in text-lg font-black leading-tight">
              {line}
            </p>
          )}
          {ev.kind === "mission" && !me && !pendingLocal && !over && <p className="mt-0.5 text-sm font-bold opacity-90">{e.missionHow(qr)}</p>}
          {me?.powerup && <p className="mt-0.5 font-black text-gold">{e.gotPowerup(e.powerups[me.powerup])}</p>}
          {ev.kind === "gather" && over && !me && <p className="mt-0.5 font-bold">{e.lateExercise}</p>}
        </div>
        <div className="text-right">
          {!over && <p className="font-mono text-2xl font-black tabular-nums">{formatClock(left)}</p>}
          {dir && <p className="text-sm font-black tabular-nums">{dir.m} m</p>}
          {ev.kind === "sprint" && !me && ev.left !== null && <p className="text-xs font-bold">{ev.left ? e.left(ev.left) : e.full}</p>}
          {over && <p className="text-xs font-bold opacity-80">{e.over}</p>}
        </div>
      </div>
      {ev.kind === "mission" && !over && !me && !pendingLocal && (
        <div className="mt-2 flex gap-2">
          <button className="ui-press min-h-12 flex-1 rounded-xl bg-ok py-3 text-lg font-black text-on-accent" onClick={onDone} data-testid="mission-done">
            {e.done}
          </button>
          {qr && (
            <button className="ui-press min-h-12 flex-1 rounded-xl border border-white/40 bg-black/30 py-3 text-lg font-black" onClick={onScan}>
              {no.play.scan}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Up to two one-tap power-ups + the ones running now. */
export function PowerBar({
  power,
  round,
  role,
  offsetMs,
  now,
  busy,
  onUse,
}: {
  power: PowerView;
  round: RoundView | null;
  role: string | undefined;
  offsetMs: number;
  now: number;
  busy: boolean;
  onUse: (k: Powerup) => void;
}) {
  const running: { k: string; text: string }[] = [];
  const leftOf = (iso: string | null) => (iso ? Math.max(0, Math.ceil((Date.parse(iso) - (now + offsetMs)) / 1000)) : 0);
  for (const k of ["radar", "turbo", "decoy"] as const) {
    const s = leftOf(power[`${k}_until`]);
    if (s > 0) running.push({ k, text: `${e.on[k]} ${s}` });
  }
  if (!power.inv.length && !running.length) return null;
  return (
    <div className="m-rise-in flex flex-wrap items-center gap-2 px-4 pb-2" data-testid="power-bar">
      {power.inv.map((k, i) => {
        const why = powerupCheck(k, round?.mode, role ?? "neutral");
        return (
          <button
            key={`${k}-${i}`}
            disabled={busy || why !== null}
            title={e.powerupHelp[k]}
            className="ui-press m-pop min-h-11 rounded-full border-2 border-gold bg-black/40 px-4 py-2 text-sm font-black text-white disabled:opacity-40"
            onClick={() => onUse(k)}
            data-testid={`powerup-${k}`}
          >
            {e.powerups[k]}
          </button>
        );
      })}
      {running.map((r) => (
        <span key={r.k} className="m-pop rounded-full bg-gold px-3 py-1.5 text-sm font-black text-on-accent">
          {r.text}
        </span>
      ))}
    </div>
  );
}
