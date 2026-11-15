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
import { IconCheck, IconZap } from "@/lib/client/ui/icons";
import { no } from "@/lib/locale/no";
import { formatClock, phaseLeftS } from "@/lib/rules/game";

import HostMap from "../HostMap";
import { useHostSession } from "../useHostSession";

const sc = no.screen;
const prize = no.host.prize;

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
        <p className="text-2xl font-black uppercase tracking-[0.3em] text-gold-text">{prize.title}</p>
        {c.step === 0 || !last ? (
          <p className="m-rise-in mt-12 text-8xl font-black tracking-tight">{prize.intro}</p>
        ) : (
          <div key={c.step} className="m-scale-in mt-10 w-full max-w-3xl">
            <p className="mb-5 text-center text-2xl font-bold text-txt-dim">{prize.of(Math.min(c.step, c.total), c.total)}</p>
            <PodiumCard podium={last} big />
          </div>
        )}
      </Full>
    );
  }

  if (snap.status === "lobby") {
    return (
      <Full>
        <div className="m-rise-in flex flex-col items-center">
          <p className="text-3xl font-black uppercase tracking-[0.3em] text-txt-dim">{no.host.lobbyTitle}</p>
          <div className="mt-12 flex flex-wrap items-center justify-center gap-20">
            {origin && (
              <div className="rounded-[2.5rem] bg-white p-6 shadow-[var(--shadow-float)]">
                <QRCode value={`${origin}/j/${snap.pin}`} size={380} />
              </div>
            )}
            <div className="text-left">
              <p className="text-2xl font-bold uppercase tracking-[0.2em] text-txt-dim">{no.host.pin}</p>
              <p className="font-mono text-[11rem] font-black leading-none tracking-[0.12em]">{snap.pin}</p>
              <span className="mt-5 block h-2 w-32 rounded-full bg-gold" aria-hidden />
              {origin && (
                <p className="mt-6 text-3xl font-bold text-txt-dim">
                  {no.host.scan} <span className="text-txt">{origin.replace(/^https?:\/\//, "")}</span>
                </p>
              )}
            </div>
          </div>
          <p key={snap.players.length} className="m-pop mt-16 text-6xl font-black tabular-nums">{sc.players(snap.players.length)}</p>
        </div>
      </Full>
    );
  }

  return (
    <div className="theme-dark m-fade-in grid h-dvh w-full grid-cols-[1fr_30rem] bg-ink text-txt" data-testid="big-screen">
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
      <aside className="flex flex-col gap-10 border-l border-line bg-ink-2 p-10">
        <div key={`${snap.status}-${r?.idx ?? -1}`} className="m-fade-in">
          <p className="text-xl font-bold uppercase tracking-[0.2em] text-txt-dim">{no.host.status[snap.status] ?? snap.status}</p>
          {r && <p className="mt-2 text-4xl font-black leading-tight">{roundName}</p>}
          {r && <p className="mt-1 text-2xl font-bold text-txt-dim">{no.host.round.of(r.idx + 1, r.count)}</p>}
          {snap.playlist_done ? (
            <p className="mt-8 flex items-start gap-4 text-4xl font-black leading-tight">
              <span className="mt-1 grid size-12 shrink-0 place-items-center rounded-full bg-ok text-on-accent" aria-hidden>
                <IconCheck size={28} />
              </span>
              {no.host.round.done}
            </p>
          ) : (
            <p className="mt-3 font-mono text-[7.5rem] font-black leading-none tabular-nums">{formatClock(left)}</p>
          )}
        </div>
        {ev && (
          <div key={ev.kind} className="m-drop-in rounded-[1.5rem] bg-gold px-6 py-5 text-on-accent shadow-[var(--shadow-float)]">
            <p className="flex items-center gap-3 text-3xl font-black">
              <IconZap size={30} className="shrink-0" />
              {no.events.kinds[ev.kind]}
            </p>
            {ev.mission_text && <p className="mt-1 text-xl font-bold">{ev.mission_text}</p>}
          </div>
        )}
        {teams.length >= 2 && (
          <div>
            <p className="text-xl font-bold uppercase tracking-[0.2em] text-txt-dim">{sc.teams}</p>
            <div className="mt-4 space-y-3">
              {teams.map((t) => (
                <div key={t.n} className="flex items-center justify-between rounded-[1.25rem] px-5 py-3.5 text-3xl font-black transition-transform duration-[var(--dur-3)]" style={{ background: t.color, color: t.color === "#f5b800" ? "#111827" : "#fff" }}>
                  <span>{t.name}</span>
                  <span className="tabular-nums">
                    {r?.relay && <span className="mr-3 text-xl opacity-80">{no.relay.legs(r.relay.legs[String(t.n)] ?? 0)}</span>}
                    <span key={t.points} className="m-bump inline-block">{t.points}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        <p className="mt-auto text-3xl font-black text-txt-dim">{sc.join(snap.pin)}</p>
      </aside>
    </div>
  );
}

function Full({ children }: { children: React.ReactNode }) {
  return <main className="theme-dark flex h-dvh w-full flex-col items-center justify-center bg-ink p-8 text-center text-txt">{children}</main>;
}
