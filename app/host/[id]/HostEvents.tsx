"use client";

// Teacher's ⚡ (0007, PLAN §4/§6): start an event in two taps (⚡ → kind),
// follow it (countdown, who made it), stop it, confirm missions, and switch
// the automatic events on/off. The server decides what fits the round.

import { useEffect, useState } from "react";

import type { HostEventView, Snapshot } from "@/lib/client/api";
import { no } from "@/lib/locale/no";
import { formatClock } from "@/lib/rules/game";
import type { EventKind } from "@/lib/rules/events";

import type { HostSession } from "./useHostSession";

const e = no.events;

function useLeftS(until: string | null | undefined, serverNow: string): number | null {
  const [now, setNow] = useState(() => Date.now());
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- server clock offset from the last poll
    setOffset(Date.parse(serverNow) - Date.now());
  }, [serverNow]);
  if (!until) return null;
  return Math.max(0, Math.ceil((Date.parse(until) - (now + offset)) / 1000));
}

/** Small chip under the round bar while an event runs. Tap → the sheet. */
export function EventChip({ snap, onOpen }: { snap: Snapshot; onOpen: () => void }) {
  const ev = snap.event;
  const left = useLeftS(ev?.ends_at, snap.server_now);
  const pending = snap.mission_pending?.length ?? 0;
  if ((!ev || ev.done) && !pending) return null;
  return (
    <button
      className="pointer-events-auto flex w-full items-center justify-between gap-2 rounded-xl bg-gold px-3 py-2 text-left text-sm font-black text-on-accent"
      onClick={onOpen}
      data-testid="event-chip"
    >
      <span className="truncate">
        {ev && !ev.done ? `${e.kinds[ev.kind]} · ${e.entries(ev.entries.filter((x) => x.state !== "pending").length)}` : e.pendingTitle(pending)}
      </span>
      {ev && !ev.done && <span className="font-mono tabular-nums">{formatClock(left)}</span>}
      {pending > 0 && ev && !ev.done && <span className="rounded-full bg-ink px-2 text-gold">{pending}</span>}
    </button>
  );
}

export function EventSheet({ snap, hs }: { snap: Snapshot; hs: HostSession }) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ev = snap.event;
  const running = ev && !ev.done ? ev : null;
  const kinds = snap.event_kinds ?? [];
  const pending = snap.mission_pending ?? [];

  async function run(action: Parameters<HostSession["tryAct"]>[0], payload?: Record<string, unknown>) {
    setBusy(true);
    const code = await hs.tryAct(action, payload);
    setBusy(false);
    setErr(code ? (e.errors[code] ?? no.host.errors.default) : null);
    return !code;
  }

  return (
    <div className="space-y-3" data-testid="event-sheet">
      <h2 className="text-xl font-black">{e.title}</h2>
      {err && <p className="rounded-xl bg-warn px-3 py-2 text-sm font-bold text-on-accent">{err}</p>}

      {running ? (
        <RunningEvent ev={running} serverNow={snap.server_now} onStop={() => void run("event_stop")} />
      ) : kinds.length ? (
        <div className="grid gap-2">
          {kinds.map((k: EventKind) => (
            <button
              key={k}
              disabled={busy}
              className="rounded-2xl bg-ink px-4 py-3 text-left hover:bg-ink-3 disabled:opacity-50"
              onClick={() => void run("event_start", { kind: k })}
              data-testid={`event-${k}`}
            >
              <span className="block text-lg font-black">{e.kinds[k]}</span>
              <span className="block text-sm text-txt-dim">{e.hostDesc[k]}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="text-sm text-txt-dim">{e.notLive}</p>
      )}

      {pending.length > 0 && (
        <div className="rounded-2xl border border-gold/50 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="font-black">{e.pendingTitle(pending.length)}</p>
            <button className="rounded-lg bg-gold px-3 py-2 text-sm font-black text-on-accent" onClick={() => void run("mission_confirm")} data-testid="confirm-all">
              {e.confirmAll}
            </button>
          </div>
          <ul className="mt-2 space-y-1">
            {pending.map((p) => (
              <li key={p.player_id} className="flex items-center justify-between rounded-xl bg-ink px-3 py-2">
                <span className="font-bold">{p.nickname}</span>
                <button className="rounded-lg bg-ok px-3 py-1 text-sm font-black text-on-accent" onClick={() => void run("mission_confirm", { player_id: p.player_id })}>
                  {e.confirm}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {snap.events_every_s > 0 && (
        <div className="flex items-center justify-between gap-2 rounded-xl bg-ink px-3 py-2">
          <span className="text-sm font-bold">{e.autoState(snap.events_auto, snap.events_every_s)}</span>
          <button className="rounded-lg border border-line px-3 py-1 text-sm font-black" onClick={() => void run("events_auto", { on: !snap.events_auto })}>
            {snap.events_auto ? e.autoOff : e.autoOn}
          </button>
        </div>
      )}
    </div>
  );
}

function RunningEvent({ ev, serverNow, onStop }: { ev: HostEventView; serverNow: string; onStop: () => void }) {
  const left = useLeftS(ev.ends_at, serverNow);
  const made = ev.entries.filter((x) => x.state !== "pending");
  return (
    <div className="rounded-2xl bg-ink p-3">
      <div className="flex items-center justify-between">
        <p className="text-lg font-black">{e.kinds[ev.kind]}</p>
        <p className="font-mono text-2xl font-black tabular-nums">{formatClock(left)}</p>
      </div>
      {ev.kind === "mission" && (ev.mission_text || ev.mission !== null) && (
        <p className="mt-1 font-bold text-gold">{ev.mission_text ?? e.missions[ev.mission!]}</p>
      )}
      <p className="mt-1 text-sm text-txt-dim">{e.hostDesc[ev.kind]}</p>
      {made.length > 0 && (
        <ol className="mt-2 space-y-1 text-sm">
          {made.map((x) => (
            <li key={x.player_id} className="flex justify-between rounded-lg bg-ink-2 px-2 py-1">
              <span className="font-bold">{x.place ? `${x.place}. ` : ""}{x.nickname}</span>
              <span>+{x.points}{x.powerup ? ` · ${e.powerups[x.powerup]}` : ""}</span>
            </li>
          ))}
        </ol>
      )}
      <button className="mt-3 w-full rounded-xl bg-danger/15 py-2 font-black text-danger" onClick={onStop}>
        {e.stop}
      </button>
    </div>
  );
}
