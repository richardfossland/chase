"use client";

// Storskjerm (fase 7, PLAN §2/§13): projector view for the gym hall — round
// clock, an overview map without names, team points and flags/hill, the
// event, and the ceremony in big format. Read-only; uses the teacher's host
// token from this browser (open it on the PC by the projector, or cast the tab).

import "maplibre-gl/dist/maplibre-gl.css";

import { useEffect, useMemo, useState } from "react";

import { PodiumCard } from "@/lib/client/Ceremony";
import { identity } from "@/lib/client/identity";
import { QRCode } from "@/lib/client/QRCode";
import { no } from "@/lib/locale/no";
import { formatClock, phaseLeftS } from "@/lib/rules/game";

import HostMap from "../HostMap";
import { useHostSession } from "../useHostSession";

const sc = no.screen;

export default function BigScreen({ sessionId }: { sessionId: string }) {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is client-only
    setToken(identity.hostToken(sessionId));
  }, [sessionId]);
  const hs = useHostSession(sessionId, token ?? null);
  const [now, setNow] = useState(() => Date.now());
  const [origin, setOrigin] = useState("");
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- window is client-only
    setOrigin(window.location.origin);
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);
  const snap = hs.snap;
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- server clock offset from the last poll
    if (snap) setOffset(Date.parse(snap.server_now) - Date.now());
  }, [snap]);
  const noSos = useMemo(() => new Set<string>(), []);

  if (token === undefined) return null;
  if (!token || hs.error === "auth") return <Full><p className="text-3xl font-black">{sc.noToken}</p></Full>;
  if (!snap || !hs.geo) return <Full><p className="text-3xl font-black opacity-70">…</p></Full>;

  const r = snap.round;
  const left = phaseLeftS(r?.phase_ends_at, offset, now);
  const modes = no.host.round.modes;
  const roundName = r ? (r.mode === "tag" ? no.host.round.variants[r.variant ?? "convert"] : modes[r.mode]) : "";
  const teams = [...(snap.teams ?? [])].sort((a, b) => a.n - b.n);
  const ev = snap.event && !snap.event.done ? snap.event : null;

  if (snap.status === "ceremony" && snap.ceremony) {
    const c = snap.ceremony;
    const last = c.revealed[c.revealed.length - 1];
    return (
      <Full>
        <p className="text-2xl font-black uppercase tracking-widest text-gold">{no.ceremony.title}</p>
        {c.step === 0 || !last ? (
          <p className="mt-10 text-8xl font-black">{no.ceremony.intro}</p>
        ) : (
          <div key={c.step} className="mt-8 w-full max-w-3xl animate-[flash_0.6s_ease-out]">
            <p className="mb-4 text-center text-2xl font-bold opacity-70">{no.ceremony.of(Math.min(c.step, c.total), c.total)}</p>
            <PodiumCard podium={last} big />
          </div>
        )}
      </Full>
    );
  }

  if (snap.status === "lobby") {
    return (
      <Full>
        <p className="text-3xl font-black text-gold">{sc.title}</p>
        <p className="mt-6 font-mono text-[9rem] font-black leading-none tracking-[0.15em]">{snap.pin}</p>
        {origin && <div className="mt-6 rounded-3xl bg-white p-4"><QRCode value={`${origin}/j/${snap.pin}`} size={320} /></div>}
        <p className="mt-6 text-4xl font-black">{sc.players(snap.players.length)}</p>
      </Full>
    );
  }

  return (
    <div className="grid h-dvh w-full grid-cols-[1fr_28rem] bg-ink text-txt" data-testid="big-screen">
      <div className="relative">
        <HostMap
          geo={hs.geo}
          players={snap.players}
          posts={snap.posts ?? []}
          sosPlayers={noSos}
          status={snap.status}
          zone={r?.zone ?? null}
          serverNow={snap.server_now}
          eventTarget={ev && ev.kind === "sprint" ? ev.target : null}
          teams={snap.teams}
          teamOf={snap.team_of}
          flags={r?.flags ?? null}
          hill={r?.hill ?? null}
          relay={r?.relay ?? null}
          anonymous
          onSelect={() => {}}
        />
      </div>
      <aside className="flex flex-col gap-6 border-l border-line bg-ink-2 p-6">
        <div>
          <p className="text-xl font-bold opacity-70">{no.host.status[snap.status] ?? snap.status}</p>
          {r && <p className="text-3xl font-black">{no.host.round.of(r.idx + 1, r.count)} · {roundName}</p>}
          <p className="mt-2 font-mono text-[7rem] font-black leading-none tabular-nums">{formatClock(left)}</p>
        </div>
        {ev && (
          <div className="rounded-2xl bg-gold px-4 py-3 text-on-accent">
            <p className="text-3xl font-black">{no.events.kinds[ev.kind]}</p>
            {ev.mission_text && <p className="mt-1 text-xl font-bold">{ev.mission_text}</p>}
          </div>
        )}
        {teams.length >= 2 && (
          <div>
            <p className="text-xl font-bold opacity-70">{sc.teams}</p>
            <div className="mt-2 space-y-2">
              {teams.map((t) => (
                <div key={t.n} className="flex items-center justify-between rounded-2xl px-4 py-3 text-3xl font-black" style={{ background: t.color, color: t.color === "#f5b800" ? "#111827" : "#fff" }}>
                  <span>{t.name}</span>
                  <span className="tabular-nums">
                    {r?.relay && <span className="mr-3 text-xl opacity-80">{no.relay.legs(r.relay.legs[String(t.n)] ?? 0)}</span>}
                    {t.points}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        <p className="mt-auto text-2xl font-black opacity-80">{sc.join(snap.pin)}</p>
      </aside>
    </div>
  );
}

function Full({ children }: { children: React.ReactNode }) {
  return <main className="flex h-dvh w-full flex-col items-center justify-center bg-ink p-8 text-center text-txt">{children}</main>;
}
