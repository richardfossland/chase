"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { HostAlarm, HostPlayer, Snapshot } from "@/lib/client/api";
import { ConfirmDialog } from "@/lib/client/ConfirmDialog";
import { identity } from "@/lib/client/identity";
import { QRCode } from "@/lib/client/QRCode";
import { audioReady, unlockAudio } from "@/lib/client/sound";
import { no } from "@/lib/locale/no";
import { formatClock, phaseLeftS, planTotalS } from "@/lib/rules/game";
import { SAFETY } from "@/lib/rules/safety";

import HostMap, { dotState, type HostMapHandle } from "./HostMap";
import { useHostSession, type HostSession } from "./useHostSession";

const h = no.host;

function roundName(r: { mode: string; variant?: string | null; zone?: unknown; zoned?: boolean }): string {
  const base = r.mode === "tag" ? h.round.variants[r.variant ?? "convert"] : h.round.modes[r.mode];
  return r.zoned || r.zone === true ? base + h.round.zoneTag : base;
}

type Sheet =
  | null
  | { kind: "player"; id: string }
  | { kind: "message"; to: string | null }
  | { kind: "more" }
  | { kind: "players"; missingOnly?: boolean }
  | { kind: "qr" };

type Confirm = null | { message: string; label?: string; danger?: boolean; run: () => void };

/**
 * Teacher panel, mobile first (PLAN §6): full-screen map, alarm strip on top,
 * big bottom buttons, player card, messages, gathering + roll call, end.
 * On wide screens a player list column is always visible.
 */
export default function HostPanel({ sessionId }: { sessionId: string }) {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is client-only
    setToken(identity.hostToken(sessionId));
  }, [sessionId]);

  const hs = useHostSession(sessionId, token ?? null);

  if (token === undefined) return null;
  if (!token || hs.error === "auth") {
    return (
      <Center>
        <p className="text-lg font-bold">{h.noToken}</p>
        <Link href="/" className="mt-4 text-gold underline">
          {no.common.home}
        </Link>
      </Center>
    );
  }
  if (!hs.snap || !hs.geo) return <Center>…</Center>;
  if (hs.snap.status === "ended") {
    return (
      <Center>
        <p className="text-5xl">✔</p>
        <h1 className="mt-3 text-3xl font-black">{h.end.ended}</h1>
        <p className="mt-2 text-txt-dim">{h.end.endedBody}</p>
        <Link href="/ny" className="mt-6 rounded-xl bg-gold px-6 py-3 font-extrabold text-ink">
          {h.end.newSession}
        </Link>
      </Center>
    );
  }
  return <Panel hs={hs as HostSession & { snap: Snapshot; geo: NonNullable<HostSession["geo"]> }} />;
}

function Panel({ hs }: { hs: HostSession & { snap: Snapshot; geo: NonNullable<HostSession["geo"]> } }) {
  const { snap, geo } = hs;
  const mapRef = useRef<HostMapHandle>(null);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [sound, setSound] = useState(false);
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- window/audio are client-only
    setOrigin(window.location.origin);
    setSound(audioReady());
  }, []);

  const sosPlayers = useMemo(
    () => new Set(snap.alarms.filter((a) => a.kind === "sos" && !a.resolved).map((a) => a.player_id ?? "")),
    [snap.alarms],
  );
  const byId = useMemo(() => new Map(snap.players.map((p) => [p.id, p])), [snap.players]);
  const select = useCallback((id: string) => setSheet({ kind: "player", id }), []);
  const lobby = snap.status === "lobby";
  const gathering = snap.status === "gathering";
  const paused = snap.status === "paused";
  const joinUrl = origin ? `${origin}/j/${snap.pin}` : "";
  const playlistDone = snap.playlist_done;
  const qrCount = snap.plan?.qr_posts ?? 0;

  function focusAlarm(a: HostAlarm) {
    if (a.pos) mapRef.current?.flyTo(a.pos.lat, a.pos.lng);
    if (a.player_id && byId.has(a.player_id)) setSheet({ kind: "player", id: a.player_id });
  }

  function endFlow() {
    setSheet(null);
    setConfirm({
      message: h.end.confirm,
      label: h.endSession,
      danger: true,
      run: async () => {
        const r = await hs.end(false);
        if (!r.ok && r.missing.length) {
          setConfirm({
            message: h.end.missing(r.missing.map((m) => m.nickname).join(", ")),
            label: h.end.force,
            danger: true,
            run: () => void hs.end(true),
          });
        }
      },
    });
  }

  const checkedIn = snap.players.filter((p) => p.checked_in).length;
  const missing = snap.players.filter((p) => !p.checked_in && p.role !== "referee");

  return (
    <div
      className="relative h-dvh w-full overflow-hidden lg:grid lg:grid-cols-[1fr_22rem]"
      onPointerDown={() => {
        if (!sound) {
          unlockAudio();
          setTimeout(() => setSound(audioReady()), 50);
        }
      }}
    >
      <div className="relative h-full">
        {lobby ? (
          <LobbyBoard pin={snap.pin} joinUrl={joinUrl} players={snap.players} onSelect={select} snap={snap} sessionId={hs.sessionId} />
        ) : (
          <HostMap
            ref={mapRef}
            geo={geo}
            players={snap.players}
            posts={snap.posts ?? []}
            sosPlayers={sosPlayers}
            status={snap.status}
            zone={snap.round?.zone ?? null}
            serverNow={snap.server_now}
            onSelect={select}
          />
        )}

        {/* top: status + alarm strip */}
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 space-y-2 p-2 pt-[max(0.5rem,env(safe-area-inset-top))] lg:max-w-xl">
          <div className="pointer-events-auto flex items-center justify-between gap-2">
            <span className={`rounded-full px-3 py-1.5 text-sm font-black ${paused ? "bg-warn text-ink" : gathering ? "bg-ok text-ink" : "bg-ink-2/95 text-txt"}`}>
              {h.status[snap.status] ?? snap.status} · PIN {snap.pin}
            </span>
            {!sound && (
              <button className="rounded-full bg-danger px-3 py-1.5 text-xs font-black text-white" onClick={() => unlockAudio()}>
                {h.soundOff}
              </button>
            )}
          </div>
          <RoundBar snap={snap} act={hs.act} onConfirm={setConfirm} />
          <AlarmStrip alarms={snap.alarms} onAck={(ids) => ids.forEach((id) => void hs.ack(id))} onFocus={focusAlarm} />
          {hs.error === "network" || hs.error === "timeout" ? (
            <p className="pointer-events-auto rounded-xl bg-warn px-3 py-2 text-sm font-bold text-ink">{h.errors.network}</p>
          ) : null}
        </div>

        {/* gathering roll call */}
        {gathering && (
          <button
            className="absolute inset-x-2 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-10 flex items-center justify-between rounded-2xl border border-line bg-ink-2/95 px-4 py-3 text-left lg:hidden"
            onClick={() => setSheet({ kind: "players", missingOnly: true })}
          >
            <span className="font-extrabold">
              🧲 {h.gatherPanel.title}: {h.gatherPanel.here(checkedIn, snap.players.length)}
            </span>
            <span className={`font-black ${missing.length ? "text-warn" : "text-ok"}`}>{h.gatherPanel.missing(missing.length)} ▸</span>
          </button>
        )}

        {/* bottom bar */}
        <nav className="absolute inset-x-0 bottom-0 z-10 grid grid-cols-4 gap-2 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          {gathering && playlistDone ? (
            <>
              <BarButton icon="■" label={h.endSession} tone="gold" className="col-span-2" onClick={endFlow} />
              <BarButton icon="📣" label={h.message} onClick={() => setSheet({ kind: "message", to: null })} />
              <BarButton icon="⋯" label={h.more} onClick={() => setSheet({ kind: "more" })} />
            </>
          ) : lobby ? (
            <>
              <BarButton
                icon="▶"
                label={h.start}
                tone="gold"
                className="col-span-2"
                disabled={snap.players.length === 0}
                onClick={() =>
                  setConfirm({ message: h.startConfirm(snap.players.length), label: h.start, run: () => void hs.act("start") })
                }
              />
              <BarButton icon="📣" label={h.message} onClick={() => setSheet({ kind: "message", to: null })} />
              <BarButton icon="⋯" label={h.more} onClick={() => setSheet({ kind: "more" })} />
            </>
          ) : (
            <>
              <BarButton
                icon={paused ? "▶" : "⏸"}
                label={paused ? h.resume : h.pause}
                tone={paused ? "gold" : undefined}
                onClick={() => void hs.act(paused ? "resume" : "pause")}
              />
              <BarButton icon="📣" label={h.message} onClick={() => setSheet({ kind: "message", to: null })} />
              <BarButton
                icon="🧲"
                label={gathering ? h.endGather : h.gather}
                tone={gathering ? "ok" : undefined}
                onClick={() => void hs.act(gathering ? "end_gather" : "gather")}
              />
              <BarButton icon="⋯" label={h.more} onClick={() => setSheet({ kind: "more" })} />
            </>
          )}
        </nav>
      </div>

      {/* tablet / PC: always-visible list */}
      <aside className="hidden h-dvh overflow-y-auto border-l border-line bg-ink-2 p-3 lg:block">
        <PlayerList players={snap.players} status={snap.status} sosPlayers={sosPlayers} onSelect={select} act={hs.act} />
      </aside>

      {sheet && (
        <SheetFrame onClose={() => setSheet(null)}>
          {sheet.kind === "player" && byId.get(sheet.id) && (
            <PlayerCard
              p={byId.get(sheet.id)!}
              status={snap.status}
              hs={hs}
              onMessage={() => setSheet({ kind: "message", to: sheet.id })}
              onShow={(lat, lng) => {
                mapRef.current?.flyTo(lat, lng);
                setSheet(null);
              }}
              onKick={(p) =>
                setConfirm({
                  message: h.card.kickConfirm(p.nickname),
                  label: h.card.kick,
                  danger: true,
                  run: () => {
                    void hs.act("kick", { player_id: p.id });
                    setSheet(null);
                  },
                })
              }
            />
          )}
          {sheet.kind === "message" && (
            <MessageSheet
              to={sheet.to ? (byId.get(sheet.to)?.nickname ?? null) : null}
              onSend={async (text) => {
                const ok = await hs.act("message", sheet.to ? { text, player_id: sheet.to } : { text });
                if (ok) setSheet(null);
              }}
            />
          )}
          {sheet.kind === "players" && (
            <PlayerList
              players={sheet.missingOnly ? missing : snap.players}
              status={snap.status}
              sosPlayers={sosPlayers}
              onSelect={select}
              act={hs.act}
            />
          )}
          {sheet.kind === "qr" && (
            <div className="flex flex-col items-center gap-3 py-2">
              {joinUrl && <QRCode value={joinUrl} size={240} />}
              <p className="font-mono text-5xl font-black tracking-[0.15em] text-gold">{snap.pin}</p>
            </div>
          )}
          {sheet.kind === "more" && (
            <div className="grid gap-2">
              <SheetButton onClick={() => setSheet({ kind: "qr" })}>▦ {h.showQr}</SheetButton>
              {qrCount > 0 && (
                <Link href={`/host/${hs.sessionId}/poster`} className="rounded-xl bg-ink px-3 py-3 text-left font-bold hover:bg-ink-3">
                  {h.printQr(qrCount)}
                </Link>
              )}
              <SheetButton onClick={() => setSheet({ kind: "players" })}>👥 {h.playersList} ({snap.players.length})</SheetButton>
              <SheetButton danger onClick={endFlow}>
                ■ {h.endSession}
              </SheetButton>
            </div>
          )}
        </SheetFrame>
      )}

      {confirm && (
        <ConfirmDialog
          message={confirm.message}
          confirmLabel={confirm.label}
          danger={confirm.danger}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const run = confirm.run;
            setConfirm(null);
            run();
          }}
        />
      )}
    </div>
  );
}

/** One row per (pupil, kind): a re-entry while an earlier one is unacked would
 * otherwise show twice. The row is as urgent as its most urgent alarm, and
 * «Kvitter» acks every alarm in the group. Input is already severity-sorted. */
export function groupAlarms(alarms: HostAlarm[]) {
  const groups = new Map<string, { a: HostAlarm; ids: string[] }>();
  for (const a of alarms) {
    const key = `${a.player_id ?? a.id}:${a.kind}`;
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { a: { ...a }, ids: a.acked ? [] : [a.id] });
      continue;
    }
    if (!a.acked) g.ids.push(a.id);
    g.a.acked = g.a.acked && a.acked;
    g.a.resolved = g.a.resolved && a.resolved;
    g.a.level = Math.max(g.a.level, a.level);
    if (a.pos && !a.resolved) g.a.pos = a.pos;
  }
  return [...groups.values()];
}

function AlarmStrip({ alarms, onAck, onFocus }: { alarms: HostAlarm[]; onAck: (ids: string[]) => void; onFocus: (a: HostAlarm) => void }) {
  if (!alarms.length) return null;
  return (
    <ul className="pointer-events-auto max-h-[40dvh] space-y-1.5 overflow-y-auto" aria-live="assertive" data-testid="alarm-strip">
      {groupAlarms(alarms).map(({ a, ids }) => {
        const urgent = !a.acked;
        const sos = a.kind === "sos";
        return (
          <li
            key={a.id}
            className={`flex items-center gap-2 rounded-xl px-3 py-2 shadow-lg ${
              urgent ? (sos ? "animate-pulse bg-danger text-white" : "bg-danger/95 text-white") : "bg-ink-2/95 text-txt-dim"
            }`}
          >
            <button className="min-w-0 flex-1 text-left" onClick={() => onFocus(a)}>
              <span className="font-black">{sos ? "🆘 " : ""}{h.alarms[a.kind] ?? a.kind}</span>
              {a.level >= 2 && a.kind === "outside" ? <span className="font-bold"> · {h.alarmHigh}</span> : null}
              <span className="block truncate text-sm font-bold opacity-90">
                {a.nickname ?? "?"}
                {a.resolved ? ` · ${h.over}` : ""}
              </span>
            </button>
            {urgent ? (
              <button className="rounded-lg bg-white px-3 py-2 text-sm font-black text-ink" onClick={() => onAck(ids)}>
                {h.ack}
              </button>
            ) : (
              <span className="text-xs font-bold">{h.seen}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function LobbyBoard({
  pin,
  joinUrl,
  players,
  onSelect,
  snap,
  sessionId,
}: {
  pin: string;
  joinUrl: string;
  players: HostPlayer[];
  onSelect: (id: string) => void;
  snap: Snapshot;
  sessionId: string;
}) {
  const plan = snap.plan;
  return (
    <div className="h-full overflow-y-auto px-4 pt-16 pb-28">
      <section className="mx-auto flex max-w-3xl flex-col items-center gap-4 rounded-3xl border border-line bg-ink-2 p-6 text-center sm:flex-row sm:text-left">
        {joinUrl ? <QRCode value={joinUrl} size={220} /> : <div className="size-[220px] rounded-xl bg-ink-3" />}
        <div className="flex-1">
          <h1 className="text-3xl font-black">{h.lobbyTitle}</h1>
          <p className="mt-1 text-txt-dim">
            {h.scan} <span className="font-bold text-txt">{joinUrl.replace(/^https?:\/\//, "").replace(/\/\d+$/, "")}</span>
          </p>
          <p className="mt-3 text-sm font-bold uppercase tracking-widest text-txt-dim">{h.pin}</p>
          <p className="font-mono text-6xl font-black tracking-[0.15em] text-gold" data-testid="pin">
            {pin}
          </p>
          {plan?.rounds?.length ? (
            <p className="mt-3 text-sm font-bold text-txt-dim">
              {h.round.playlist(plan.rounds.length, Math.round(planTotalS(plan) / 60))}:{" "}
              {plan.rounds.map((r) => `${roundName(r)} ${Math.round(r.duration_s / 60)}′`).join(" → ")}
            </p>
          ) : null}
          {plan?.qr_posts ? (
            <Link href={`/host/${sessionId}/poster`} className="mt-3 inline-block rounded-xl border border-gold px-4 py-2 font-extrabold text-gold">
              {h.printQr(plan.qr_posts)}
            </Link>
          ) : null}
        </div>
      </section>
      <section className="mx-auto mt-6 max-w-3xl">
        <h2 className="text-lg font-extrabold">{players.length ? h.players(players.length) : h.waiting}</h2>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {players.map((p) => {
            const b = gpsBadge(p);
            return (
              <li key={p.id}>
                <button className="flex w-full items-center justify-between rounded-xl bg-ink-2 px-3 py-2.5" onClick={() => onSelect(p.id)}>
                  <span className="font-bold">{p.nickname}</span>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${b.cls}`}>{b.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

function gpsBadge(p: HostPlayer) {
  if (p.acc === null || p.signal === "none" || p.signal === "lost") return { label: h.gps.none, cls: "bg-danger/20 text-danger" };
  if (p.acc < 15) return { label: `${h.gps.ok} ±${Math.round(p.acc)} m`, cls: "bg-ok/20 text-ok" };
  if (p.acc <= 30) return { label: `${h.gps.warn} ±${Math.round(p.acc)} m`, cls: "bg-warn/20 text-warn" };
  return { label: `${h.gps.bad} ±${Math.round(p.acc)} m`, cls: "bg-danger/20 text-danger" };
}

function PlayerList({
  players,
  status,
  sosPlayers,
  onSelect,
  act,
}: {
  players: HostPlayer[];
  status: Snapshot["status"];
  sosPlayers: Set<string>;
  onSelect: (id: string) => void;
  act: HostSession["act"];
}) {
  const gathering = status === "gathering";
  return (
    <ul className="space-y-1.5">
      {players.map((p) => {
        const s = dotState(p, sosPlayers.has(p.id), status);
        return (
          <li key={p.id} className="flex items-center gap-2 rounded-xl bg-ink px-3 py-2">
            <span className="size-3.5 shrink-0 rounded-full border-2" style={{ background: s.bg, borderColor: s.ring }} aria-hidden />
            <button className="min-w-0 flex-1 truncate text-left font-bold" onClick={() => onSelect(p.id)}>
              {p.nickname}
              <span className="ml-2 text-xs font-semibold text-txt-dim">{h.card.signal[p.signal]}</span>
            </button>
            {gathering &&
              (p.checked_in ? (
                <span className="text-sm font-bold text-ok">✔</span>
              ) : (
                <button className="rounded-lg bg-ok px-2.5 py-1.5 text-xs font-black text-ink" onClick={() => void act("check_in", { player_id: p.id })}>
                  {h.card.checkIn}
                </button>
              ))}
          </li>
        );
      })}
    </ul>
  );
}

function PlayerCard({
  p,
  status,
  hs,
  onMessage,
  onShow,
  onKick,
}: {
  p: HostPlayer;
  status: Snapshot["status"];
  hs: HostSession;
  onMessage: () => void;
  onShow: (lat: number, lng: number) => void;
  onKick: (p: HostPlayer) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(p.nickname);
  const [err, setErr] = useState<string | null>(null);
  const sitting = p.role === "sitting_out";

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-2xl font-black">{p.nickname}</h2>
        <span className="text-sm font-bold text-txt-dim">{h.card.role[p.role] ?? p.role}</span>
      </div>
      <ul className="mt-2 flex flex-wrap gap-1.5 text-xs font-bold">
        <Chip warn={p.signal !== "ok"}>
          {h.card.signal[p.signal]}
          {p.acc !== null ? ` ${h.card.accuracy(p.acc)}` : ""}
          {p.fix_age_s !== null ? ` · ${h.card.age(p.fix_age_s)}` : ""}
        </Chip>
        <Chip warn={p.geofence >= 1 || p.forbidden}>
          {p.forbidden ? h.alarms.forbidden : h.card.geofence[p.geofence]}
          {p.geofence >= 2 ? ` · ${Math.round(p.outside_m)} m` : ""}
        </Chip>
        {p.still_s !== null && p.still_s > SAFETY.still_alert_s && status === "live" && <Chip warn>{h.still(p.still_s)}</Chip>}
      </ul>
      <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
        <Stat label={h.card.distance} value={no.play.meters(p.distance_m)} />
        <Stat label={h.card.active} value={no.play.minutes(p.active_s)} />
        <Stat label={h.card.points} value={String(p.points)} />
      </dl>
      {(p.catches > 0 || p.times_caught > 0) && (
        <p className="mt-2 text-sm font-bold text-txt-dim">{h.card.tagStats(p.catches, p.times_caught)}</p>
      )}
      {(p.posts > 0 || p.badges > 0) && (
        <p className="mt-2 text-sm font-bold text-txt-dim">
          {h.card.extra(p.posts, p.badges, p.round_points)}
        </p>
      )}

      {renaming ? (
        <form
          className="mt-3 flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setErr(null);
            const ok = await hs.act("rename", { player_id: p.id, nickname: name.trim() });
            if (ok) setRenaming(false);
            else setErr(h.errors.nickname_taken);
          }}
        >
          <input
            className="min-w-0 flex-1 rounded-xl border border-line bg-ink px-3 py-2 font-bold outline-none focus:border-gold"
            value={name}
            maxLength={20}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <button className="rounded-xl bg-gold px-4 font-black text-ink">{h.card.save}</button>
        </form>
      ) : null}
      {err && <p className="mt-2 text-sm font-semibold text-danger">{err}</p>}

      <div className="mt-4 grid grid-cols-2 gap-2">
        {p.pos && <SheetButton onClick={() => onShow(p.pos!.lat, p.pos!.lng)}>📍 {h.card.showOnMap}</SheetButton>}
        <SheetButton onClick={onMessage}>📣 {h.card.sendMessage}</SheetButton>
        {status === "gathering" && (
          <SheetButton onClick={() => void hs.act("check_in", { player_id: p.id, checked: !p.checked_in })}>
            {p.checked_in ? h.card.uncheck : `✔ ${h.card.checkIn}`}
          </SheetButton>
        )}
        <SheetButton onClick={() => void hs.act("sit_out", { player_id: p.id, on: !sitting })}>
          {sitting ? `↩ ${h.card.sitIn}` : `🩹 ${h.card.sitOut}`}
        </SheetButton>
        <SheetButton onClick={() => setRenaming((r) => !r)}>✏️ {h.card.rename}</SheetButton>
        <SheetButton danger onClick={() => onKick(p)}>
          ✕ {h.card.kick}
        </SheetButton>
      </div>
    </div>
  );
}

function MessageSheet({ to, onSend }: { to: string | null; onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) onSend(text.trim());
      }}
    >
      <h2 className="text-xl font-black">{h.msg.title(to)}</h2>
      <div className="mt-3 flex flex-wrap gap-2">
        {h.msg.quick.map((q) => (
          <button key={q} type="button" className="rounded-full border border-line px-3 py-2 text-sm font-bold" onClick={() => onSend(q)}>
            {q}
          </button>
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <input
          className="min-w-0 flex-1 rounded-xl border border-line bg-ink px-3 py-3 font-bold outline-none focus:border-gold"
          placeholder={h.msg.placeholder}
          maxLength={200}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button className="rounded-xl bg-gold px-5 font-black text-ink disabled:opacity-40" disabled={!text.trim()}>
          {h.msg.send}
        </button>
      </div>
    </form>
  );
}

function SheetFrame({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-40 flex items-end bg-black/40 lg:items-center lg:justify-center" onClick={onClose}>
      <div
        className="max-h-[80dvh] w-full overflow-y-auto rounded-t-3xl border border-line bg-ink-2 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] lg:max-w-md lg:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
      >
        <div className="mb-3 flex justify-end">
          <button className="text-sm font-bold text-txt-dim" onClick={onClose}>
            {h.close} ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function BarButton({
  icon,
  label,
  onClick,
  tone,
  className = "",
  disabled,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  tone?: "gold" | "ok";
  className?: string;
  disabled?: boolean;
}) {
  const bg = tone === "gold" ? "bg-gold text-ink" : tone === "ok" ? "bg-ok text-ink" : "bg-ink-2/95 text-txt border border-line";
  return (
    <button
      className={`flex min-h-16 flex-col items-center justify-center rounded-2xl font-black shadow-lg backdrop-blur active:scale-[0.97] disabled:opacity-40 ${bg} ${className}`}
      onClick={onClick}
      disabled={disabled}
    >
      <span className="text-xl leading-none">{icon}</span>
      <span className="mt-1 text-xs">{label}</span>
    </button>
  );
}

function SheetButton({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      className={`rounded-xl px-3 py-3 text-left font-bold ${danger ? "bg-danger/15 text-danger" : "bg-ink hover:bg-ink-3"}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Chip({ children, warn }: { children: React.ReactNode; warn?: boolean }) {
  return <li className={`rounded-full px-2.5 py-1 ${warn ? "bg-warn/20 text-warn" : "bg-ok/15 text-ok"}`}>{children}</li>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-ink px-2 py-2">
      <dt className="text-[11px] font-bold uppercase text-txt-dim">{label}</dt>
      <dd className="text-lg font-black">{value}</dd>
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <main className="flex min-h-dvh flex-col items-center justify-center px-6 text-center">{children}</main>;
}

/** Round clock + teacher round controls (PLAN §13 phase 2: «neste runde, forleng»). */
function RoundBar({
  snap,
  act,
  onConfirm,
}: {
  snap: Snapshot;
  act: HostSession["act"];
  onConfirm: (c: Confirm) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- server clock offset from the last poll
    setOffset(Date.parse(snap.server_now) - Date.now());
  }, [snap.server_now]);

  const r = snap.round;
  if (!r || snap.status === "lobby") return null;
  if (snap.playlist_done) {
    return <p className="pointer-events-auto rounded-xl bg-ok px-3 py-2 text-sm font-black text-ink">✔ {h.round.done}</p>;
  }
  const left = phaseLeftS(r.phase_ends_at, offset, now);
  const live = snap.status === "live";
  const between = snap.status === "countdown" || snap.status === "breather";
  const open = (snap.posts ?? []).filter((p) => !p.claimed_by).length;
  const taken = (snap.posts ?? []).filter((p) => p.claimed_by).length;
  const btn = "rounded-lg border border-line px-3 py-2 text-sm font-black hover:bg-ink-3";
  return (
    <div className="pointer-events-auto flex items-center gap-2 rounded-xl bg-ink-2/95 px-3 py-2 backdrop-blur" data-testid="round-bar">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-black">
          {h.round.of(r.idx + 1, r.count)} · {roundName(r)}
          {snap.status !== "live" ? ` · ${h.status[snap.status]}` : ""}
        </p>
        {live && r.mode === "posts" && <p className="text-xs font-bold text-txt-dim">{h.round.posts(open, taken)}</p>}
        {live && r.mode === "tag" && (
          <p className="text-xs font-bold text-txt-dim">
            {h.round.counts(snap.players.filter((p) => p.role === "hunter").length, snap.players.filter((p) => p.role === "prey").length)}
          </p>
        )}
      </div>
      <span className="font-mono text-2xl font-black tabular-nums">{r.frozen ? "⏸" : formatClock(left)}</span>
      {live && (
        <button className={btn} onClick={() => void act("extend", { seconds: 60 })}>
          {h.round.extend}
        </button>
      )}
      {(live || between) && (
        <button
          className={btn}
          onClick={() =>
            live
              ? onConfirm({ message: h.round.nextConfirm, label: h.round.next, run: () => void act("next") })
              : void act("next")
          }
        >
          {live ? h.round.next : h.round.startNow}
        </button>
      )}
    </div>
  );
}
