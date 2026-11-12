"use client";

// Phone side of phase 5 (0009): my team (colour, place, team points), the
// objective of the round (nearest flag and who is taking it, the hill and
// when it moves) and the quick team messages. The server decides
// everything; this only shows it and sends one-tap requests.

import type { FlagView, HillView, RoundView, TeamView } from "@/lib/client/api";
import { no } from "@/lib/locale/no";
import { bearing, haversine } from "@/lib/geo";
import { TEAM_MSGS, captureLeftS, type TeamMsgKind } from "@/lib/rules/teams";
import type { Fix } from "@/lib/client/gps";

const tt = no.teams;

type Dir = { m: number; deg: number };
function dirTo(fix: Fix | null, p: { lat: number; lng: number }): Dir | null {
  if (!fix) return null;
  return { m: Math.round(haversine([fix.lng, fix.lat], [p.lng, p.lat])), deg: bearing([fix.lng, fix.lat], [p.lng, p.lat]) };
}

function nameOf(team: TeamView, n: number | null): string {
  return team.palette.find((x) => x.n === n)?.name ?? "";
}

function flagLine(team: TeamView, flags: FlagView[], fix: Fix | null, offsetMs: number, now: number, frozenAt: string | null) {
  const near = flags
    .map((f) => ({ f, d: dirTo(fix, f.pos) }))
    .sort((a, b) => (a.d?.m ?? 1e9) - (b.d?.m ?? 1e9))[0];
  const mine = flags.filter((f) => f.owner === team.n).length;
  let status: string | null = null;
  // Any flag being taken by us or from us is news, nearest or not.
  const ours = flags.find((f) => f.cap === team.n);
  const fromUs = flags.find((f) => f.owner === team.n && f.cap !== null && f.cap !== team.n);
  if (ours) status = tt.taking(captureLeftS(ours.cap_since, offsetMs, now, frozenAt) ?? 0);
  else if (fromUs) status = tt.losing(captureLeftS(fromUs.cap_since, offsetMs, now, frozenAt) ?? 0);
  else if (near && near.f.cap !== null) status = tt.contested;
  return { head: tt.flagsMine(mine, flags.length), status, dir: near?.d ?? null, near: near?.d ? tt.flagNear(near.d.m) : null };
}

function hillLine(team: TeamView, hill: HillView, fix: Fix | null, offsetMs: number, now: number) {
  const d = dirTo(fix, hill.pos);
  const ref = hill.frozen_at ? Date.parse(hill.frozen_at) : now + offsetMs;
  const moves = Math.max(0, Math.ceil((Date.parse(hill.next_at) - ref) / 1000));
  const head = hill.holder === team.n ? tt.hillHold : hill.holder ? tt.hillOther(nameOf(team, hill.holder)) : tt.hillFree;
  const inside = d !== null && d.m <= hill.r;
  return { head, status: tt.hillMoves(moves), dir: inside ? null : d, near: d ? (inside ? tt.hillIn : tt.hillTo(d.m)) : null };
}

export function TeamStrip({
  team,
  round,
  fix,
  offsetMs,
  now,
  live,
}: {
  team: TeamView;
  round: RoundView | null;
  fix: Fix | null;
  offsetMs: number;
  now: number;
  live: boolean;
}) {
  // While paused the banner says so; the hill clock stops on its own frozen_at.
  const frozenAt = round?.frozen ? (round.hill?.frozen_at ?? null) : null;
  const obj =
    live && round?.flags?.length ? flagLine(team, round.flags, fix, offsetMs, now, frozenAt)
    : live && round?.hill ? hillLine(team, round.hill, fix, offsetMs, now)
    : null;
  return (
    <div
      className="mx-4 mb-2 rounded-xl border-2 bg-black/45 px-3 py-2 text-white"
      style={{ borderColor: team.color }}
      role="status"
      data-testid="team-strip"
    >
      <div className="flex items-center gap-2 text-sm font-black">
        <span className="inline-block h-4 w-4 flex-none rounded-full border-2 border-white/70" style={{ background: team.color }} aria-hidden />
        <span>{tt.team(team.name)}</span>
        <span className="opacity-80">· {tt.place(team.rank, team.of)}</span>
        <span className="ml-auto tabular-nums opacity-90">{tt.points(team.points)}</span>
      </div>
      {obj && (
        <div className="mt-1 flex items-center gap-3">
          {obj.dir && (
            <span className="inline-block text-3xl leading-none" style={{ transform: `rotate(${obj.dir.deg}deg)` }} aria-hidden>
              ↑
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-lg font-black leading-tight">{obj.head}</p>
            {obj.status && <p className="text-sm font-bold opacity-90">{obj.status}</p>}
          </div>
          {obj.near && <p className="text-right text-sm font-black tabular-nums">{obj.near}</p>}
        </div>
      )}
    </div>
  );
}

/** Four one-tap messages to my team (team rounds only). */
export function TeamMsgBar({ busy, onSend }: { busy: boolean; onSend: (k: TeamMsgKind) => void }) {
  return (
    <div className="flex gap-1.5 px-4 pb-2" data-testid="team-msgs">
      {TEAM_MSGS.map((k) => (
        <button
          key={k}
          disabled={busy}
          className="flex-1 rounded-full border border-white/40 bg-black/35 px-1 py-1.5 text-xs font-black text-white disabled:opacity-40"
          onClick={() => onSend(k)}
          data-testid={`team-msg-${k}`}
        >
          {tt.msgs[k]}
        </button>
      ))}
    </div>
  );
}
