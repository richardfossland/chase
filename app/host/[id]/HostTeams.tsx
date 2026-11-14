"use client";

// Teacher side of phase 5 (0009): team scores under the alarm strip, the
// teams sheet (deal / redeal before the first team round, members, move a
// pupil) and the move row on the player card. The server decides.

import { useState } from "react";

import type { HostPlayer, Snapshot } from "@/lib/client/api";
import { no } from "@/lib/locale/no";

import { buttonClass } from "@/lib/client/ui";

import type { HostSession } from "./useHostSession";

const tt = no.teams;
const th = no.teams.host;

function teamText(color: string) {
  return color === "#f5b800" ? "#111827" : "#ffffff";
}

/** Live team points + the round objective, under the alarms (rule 4). */
export function TeamsChip({ snap, onOpen }: { snap: Snapshot; onOpen: () => void }) {
  const teams = snap.teams ?? [];
  if (teams.length < 2 || snap.status === "ceremony") return null;
  const r = snap.round;
  const live = snap.status === "live" || snap.status === "paused";
  const nameOf = (n: number | null) => teams.find((t) => t.n === n)?.name ?? null;
  let obj: string | null = null;
  if (live && r?.flags?.length) {
    obj = th.flags(teams.map((t) => `${t.name} ${r.flags!.filter((f) => f.owner === t.n).length}`).join(" · "));
  } else if (live && r?.hill) obj = th.hill(nameOf(r.hill.holder));
  return (
    <button
      className="host-float ui-press m-drop-in pointer-events-auto min-h-12 w-full rounded-2xl px-2.5 py-2 text-left"
      onClick={onOpen}
      data-testid="teams-chip"
    >
      <div className="flex flex-wrap gap-1.5">
        {teams.map((t) => (
          <span key={t.n} className="rounded-full px-3 py-1 text-sm font-black tabular-nums shadow-sm" style={{ background: t.color, color: teamText(t.color) }}>
            {t.name} {t.points}
          </span>
        ))}
      </div>
      {obj && <p className="mt-1.5 px-1 text-xs font-bold text-txt-dim">{obj}</p>}
    </button>
  );
}

/** Members per team, deal / redeal, tap a pupil to move them. */
export function TeamsSheet({ snap, hs, onSelect }: { snap: Snapshot; hs: HostSession; onSelect: (id: string) => void }) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const teams = snap.teams ?? [];
  const teamOf = snap.team_of ?? {};
  // Redeal only before a team round has been played (the server says teams_locked otherwise).
  const canDeal = snap.status === "lobby" || snap.status === "countdown" || snap.status === "breather";
  const deal = async () => {
    setBusy(true);
    const e = await hs.tryAct("teams_deal");
    setErr(e ? (th.errors[e] ?? no.host.errors.default) : null);
    setBusy(false);
  };
  const loose = snap.players.filter((p) => teamOf[p.id] === undefined && p.role !== "referee");
  return (
    <div className="space-y-3" data-testid="teams-sheet">
      {!teams.length && <p className="text-sm text-txt-dim">{th.notDealt}</p>}
      {canDeal && (
        <button className={buttonClass("primary", "lg", "w-full")} disabled={busy} onClick={() => void deal()} data-testid="teams-deal">
          {teams.length ? th.redeal : th.deal}
        </button>
      )}
      <p className="text-xs text-txt-dim">{th.dealHint}</p>
      {err && <p className="m-drop-in rounded-2xl bg-warn/20 px-4 py-2.5 text-sm font-bold text-warn-text">{err}</p>}
      {teams.map((t) => (
        <div key={t.n} className="m-rise-in rounded-2xl border border-line bg-ink-2 p-3 shadow-[var(--shadow-card)]" style={{ borderLeft: `6px solid ${t.color}` }}>
          <p className="flex items-center gap-2 font-black">
            <span className="inline-block h-4 w-4 rounded-full" style={{ background: t.color }} aria-hidden />
            {tt.team(t.name)}
            <span className="ml-auto text-sm tabular-nums text-txt-dim">
              {th.members(t.members)} · {t.points} p
            </span>
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {snap.players
              .filter((p) => teamOf[p.id] === t.n)
              .map((p) => (
                <button key={p.id} className="ui-press min-h-10 rounded-full bg-ink px-3 text-sm font-bold hover:bg-ink-3" onClick={() => onSelect(p.id)}>
                  {p.nickname}
                </button>
              ))}
          </div>
        </div>
      ))}
      {teams.length > 0 && loose.length > 0 && (
        <p className="text-xs text-txt-dim">{loose.map((p) => p.nickname).join(", ")}</p>
      )}
    </div>
  );
}

/** On the player card: which team, and buttons to move. */
export function TeamMoveRow({ p, snap, hs }: { p: HostPlayer; snap: Snapshot; hs: HostSession }) {
  const teams = snap.teams ?? [];
  if (teams.length < 2 || p.role === "referee") return null;
  const mine = snap.team_of?.[p.id];
  return (
    <div data-testid="team-move">
      <p className="text-[11px] font-bold uppercase tracking-wide text-txt-dim">{th.move}</p>
      <div className="mt-1.5 grid grid-cols-4 gap-1.5">
        {teams.map((t) => (
          <button
            key={t.n}
            disabled={t.n === mine}
            className="ui-press min-h-12 rounded-xl text-sm font-black shadow-sm disabled:ring-[3px] disabled:ring-txt disabled:ring-offset-2 disabled:ring-offset-ink-2"
            style={{ background: t.color, color: teamText(t.color) }}
            onClick={() => void hs.act("team_set", { player_id: p.id, team: t.n })}
            aria-pressed={t.n === mine}
          >
            {t.name}
          </button>
        ))}
      </div>
    </div>
  );
}
