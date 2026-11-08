"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, api, type HostPlayer, type Snapshot } from "@/lib/client/api";
import { identity } from "@/lib/client/identity";
import { QRCode } from "@/lib/client/QRCode";
import { useChannel } from "@/lib/client/useChannel";
import { useTabHidden } from "@/lib/client/useTabHidden";
import { no } from "@/lib/locale/no";
import { channels } from "@/lib/realtime";

const POLL_MS = 2000;

function gpsBadge(p: HostPlayer) {
  if (p.acc === null || p.signal === "none") return { label: no.host.gps.none, cls: "bg-danger/20 text-danger" };
  if (p.signal === "lost") return { label: no.host.gps.none, cls: "bg-danger/20 text-danger" };
  if (p.acc < 15) return { label: `${no.host.gps.ok} ±${Math.round(p.acc)} m`, cls: "bg-ok/20 text-ok" };
  if (p.acc <= 30) return { label: `${no.host.gps.warn} ±${Math.round(p.acc)} m`, cls: "bg-warn/20 text-warn" };
  return { label: `${no.host.gps.bad} ±${Math.round(p.acc)} m`, cls: "bg-danger/20 text-danger" };
}

/**
 * Phase-1 lobby (PLAN §2.1 step 6): full QR + PIN and a per-pupil GPS check.
 * Polls host_snapshot every 2 s; a Realtime hint on the host channel triggers
 * an immediate refetch. The full mobile panel (map, alarm strip, cards) builds on this.
 */
export default function HostLobby({ sessionId }: { sessionId: string }) {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [origin, setOrigin] = useState("");
  const hidden = useTabHidden();
  const inflight = useRef(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage/window are client-only
    setToken(identity.hostToken(sessionId));
    setOrigin(window.location.origin);
  }, [sessionId]);

  const refresh = useCallback(async () => {
    if (!token || inflight.current) return;
    inflight.current = true;
    try {
      setSnap(await api.snapshot(sessionId, token));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.code : "network");
    } finally {
      inflight.current = false;
    }
  }, [sessionId, token]);

  useEffect(() => {
    if (!token || hidden) return;
    const first = setTimeout(refresh, 0);
    const iv = setInterval(refresh, POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(iv);
    };
  }, [token, hidden, refresh]);

  useChannel(token ? channels.host(sessionId) : null, () => void refresh());

  if (token === undefined) return null;
  if (!token || error === "auth") {
    return (
      <main className="mx-auto max-w-md px-4 py-16">
        <p className="text-lg font-bold">{no.host.noToken}</p>
        <Link href="/" className="mt-4 inline-block text-gold underline">
          {no.common.home}
        </Link>
      </main>
    );
  }

  const pin = snap?.pin ?? "";
  const joinUrl = pin && origin ? `${origin}/j/${pin}` : "";
  const players = snap?.players ?? [];

  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-6 px-4 py-6 sm:py-10">
      <section className="flex flex-col items-center gap-4 rounded-3xl border border-line bg-ink-2 p-6 text-center sm:flex-row sm:text-left">
        {joinUrl ? <QRCode value={joinUrl} size={220} /> : <div className="size-[220px] rounded-xl bg-ink-3" />}
        <div className="flex-1">
          <h1 className="text-3xl font-black">{no.host.lobbyTitle}</h1>
          <p className="mt-1 text-txt-dim">
            {no.host.scan} <span className="font-bold text-txt">{origin.replace(/^https?:\/\//, "")}/j</span>
          </p>
          <p className="mt-3 text-sm font-bold uppercase tracking-widest text-txt-dim">{no.host.pin}</p>
          <p className="font-mono text-6xl font-black tracking-[0.15em] text-gold" data-testid="pin">
            {pin || "······"}
          </p>
        </div>
      </section>

      <section>
        <h2 className="text-lg font-extrabold">
          {players.length ? no.host.players(players.length) : no.host.waiting}
        </h2>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {players.map((p) => {
            const b = gpsBadge(p);
            return (
              <li key={p.id} className="flex items-center justify-between rounded-xl bg-ink-2 px-3 py-2.5">
                <span className="font-bold">{p.nickname}</span>
                <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${b.cls}`}>{b.label}</span>
              </li>
            );
          })}
        </ul>
      </section>

      {error && error !== "auth" && <p className="text-sm text-warn">{no.wizard.errors.network}</p>}
    </main>
  );
}
