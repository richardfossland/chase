"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { HostAlarm, HostPlayer, Snapshot } from "@/lib/client/api";
import { ConfirmDialog } from "@/lib/client/ConfirmDialog";
import { identity } from "@/lib/client/identity";
import { QRCode } from "@/lib/client/QRCode";
import { audioReady, unlockAudio } from "@/lib/client/sound";
import { Button, buttonClass, Card, Chip, cx, Sheet, useCountUp } from "@/lib/client/ui";
import { no } from "@/lib/locale/no";
import { formatClock, phaseLeftS, planTotalS } from "@/lib/rules/game";
import { SAFETY } from "@/lib/rules/safety";
import { CROWD_FROM } from "@/lib/rules/relay";

import { HostCeremony } from "./HostCeremony";
import { EventChip, EventSheet } from "./HostEvents";
import { TeamMoveRow, TeamsChip, TeamsSheet } from "./HostTeams";
import HostMap, { dotState, type HostMapHandle } from "./HostMap";
import { useHostSession, type HostSession } from "./useHostSession";

const h = no.host;

function roundName(r: { mode: string; variant?: string | null; zone?: unknown; zoned?: boolean; team?: boolean }): string {
  const base = r.mode === "tag" ? h.round.variants[r.variant ?? "convert"] : h.round.modes[r.mode];
  const teamed = r.team === true && r.mode !== "flag" && r.mode !== "king" && r.mode !== "relay" ? base + h.round.teamTag : base;
  return r.zoned || r.zone === true ? teamed + h.round.zoneTag : teamed;
}

type Sheet =
  | null
  | { kind: "player"; id: string }
  | { kind: "message"; to: string | null }
  | { kind: "more" }
  | { kind: "players"; missingOnly?: boolean }
  | { kind: "qr" }
  | { kind: "ceremony" }
  | { kind: "events" }
  | { kind: "teams" };

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
        <Link href="/" className={buttonClass("secondary", "md", "mt-6")}>
          {no.common.home}
        </Link>
      </Center>
    );
  }
  if (!hs.snap || !hs.geo) return <Center><span className="size-3 animate-pulse rounded-full bg-gold" aria-label="…" /></Center>;
  if (hs.snap.status === "ended") {
    return (
      <Center>
        <span className="m-pop grid size-16 place-items-center rounded-full bg-ok text-3xl font-black text-on-accent">✔</span>
        <h1 className="mt-5 text-3xl font-black">{h.end.ended}</h1>
        <p className="mt-2 max-w-sm text-txt-dim">{h.end.endedBody}</p>
        <Link href="/ny" className={buttonClass("primary", "lg", "mt-8")}>
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
  const closeSheet = useCallback(() => setSheet(null), []);
  const lobby = snap.status === "lobby";
  const gathering = snap.status === "gathering";
  const ceremony = snap.status === "ceremony";
  const paused = snap.status === "paused";
  const joinUrl = origin ? `${origin}/j/${snap.pin}` : "";
  const playlistDone = snap.playlist_done;
  const qrCount = snap.plan?.qr_posts ?? 0;
  const roundBar = !!snap.round && !lobby && !ceremony;

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

  const sheetTitle: Record<NonNullable<Sheet>["kind"], string> = {
    player: sheet?.kind === "player" ? (byId.get(sheet.id)?.nickname ?? "") : "",
    message: h.msg.title(sheet?.kind === "message" && sheet.to ? (byId.get(sheet.to)?.nickname ?? null) : null),
    more: h.more,
    players: h.playersList,
    qr: h.showQr,
    ceremony: no.ceremony.start,
    events: no.events.title,
    teams: no.teams.host.title,
  };

  return (
    <div
      className="host-panel relative h-dvh w-full overflow-hidden bg-ink lg:grid lg:grid-cols-[1fr_23rem]"
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
            eventTarget={snap.event && !snap.event.done && snap.event.kind === "sprint" ? snap.event.target : null}
            teams={snap.teams}
            teamOf={snap.team_of}
            flags={snap.round?.flags ?? null}
            hill={snap.round?.hill ?? null}
            relay={snap.round?.relay ?? null}
            selectedId={sheet?.kind === "player" ? sheet.id : null}
            onSelect={select}
          />
        )}

        {/* top: status + round + alarm strip (safety first, rule 4) */}
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex flex-col gap-2 p-3 pt-[max(0.75rem,env(safe-area-inset-top))] lg:max-w-lg">
          {(!roundBar || !sound) && (
            <div className="flex items-center justify-between gap-2">
              {!roundBar ? (
                <span
                  className={cx(
                    "pointer-events-auto inline-flex shrink-0 items-center gap-2 rounded-full px-3.5 py-2 text-sm font-extrabold whitespace-nowrap",
                    paused ? "bg-warn text-on-accent" : gathering ? "bg-ok text-on-accent" : "host-float text-txt",
                  )}
                >
                  <span className={cx("size-2 rounded-full", paused || gathering ? "bg-on-accent/70" : "bg-ok")} aria-hidden />
                  {h.status[snap.status] ?? snap.status} · PIN {snap.pin}
                </span>
              ) : (
                <span />
              )}
              {!sound && (
                <button
                  className="ui-press pointer-events-auto min-h-12 min-w-0 rounded-full bg-danger px-4 text-xs leading-tight font-black text-white shadow-[var(--shadow-float)]"
                  onClick={() => unlockAudio()}
                >
                  {h.soundOff}
                </button>
              )}
            </div>
          )}
          {roundBar && <RoundBar snap={snap} act={hs.act} onConfirm={setConfirm} />}
          <AlarmStrip alarms={snap.alarms} onAck={(ids) => ids.forEach((id) => void hs.ack(id))} onFocus={focusAlarm} />
          {/* Under the alarms: safety beats game (CLAUDE.md rule 4). */}
          {!ceremony && <EventChip snap={snap} onOpen={() => setSheet({ kind: "events" })} />}
          <TeamsChip snap={snap} onOpen={() => setSheet({ kind: "teams" })} />
          {hs.error === "network" || hs.error === "timeout" ? (
            <p className="m-drop-in pointer-events-auto rounded-2xl bg-warn px-4 py-2.5 text-sm font-bold text-on-accent shadow-[var(--shadow-float)]">
              {h.errors.network}
            </p>
          ) : null}
        </div>

        {/* gathering roll call */}
        {gathering && (
          <button
            className="host-float ui-press m-rise-in absolute inset-x-3 bottom-[calc(6rem+env(safe-area-inset-bottom))] z-10 flex min-h-14 items-center justify-between gap-3 rounded-2xl px-4 py-3 text-left lg:hidden"
            onClick={() => setSheet({ kind: "players", missingOnly: true })}
          >
            <span className="font-extrabold">
              🧲 {h.gatherPanel.title}: {h.gatherPanel.here(checkedIn, snap.players.length)}
            </span>
            <span className={cx("shrink-0 text-sm font-black", missing.length ? "text-warn-text" : "text-ok-text")}>
              {h.gatherPanel.missing(missing.length)} ›
            </span>
          </button>
        )}

        {/* ceremony (0006): under the alarm strip, own controls */}
        {ceremony && snap.ceremony && <HostCeremony view={snap.ceremony} act={hs.act} onEnd={endFlow} />}

        {/* bottom dock */}
        {!ceremony && (
          <nav className="absolute inset-x-0 bottom-0 z-10 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:mx-auto lg:max-w-2xl">
            <div
              className={cx(
                "host-float grid gap-1 rounded-[1.4rem] p-1.5",
                lobby || (gathering && playlistDone) ? "grid-cols-4" : "grid-cols-5",
              )}
            >
              {gathering && playlistDone ? (
                <>
                  {/* The playlist is done: the ceremony is the next step, so it is the main button. */}
                  <BarButton label={no.ceremony.start} tone="gold" wide onClick={() => setSheet({ kind: "ceremony" })} />
                  <BarButton icon="📣" label={h.message} onClick={() => setSheet({ kind: "message", to: null })} />
                  <BarButton icon="⋯" label={h.more} onClick={() => setSheet({ kind: "more" })} />
                </>
              ) : lobby ? (
                <>
                  <BarButton
                    icon="▶"
                    label={h.start}
                    tone="gold"
                    wide
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
                  {/* PLAN §6: ⏸ · 📣 · ⚡ · 🧲 · ⋯ (⚡ needs a round, 0007) */}
                  <BarButton
                    icon={paused ? "▶" : "⏸"}
                    label={paused ? h.resume : h.pause}
                    tone={paused ? "gold" : undefined}
                    onClick={() => void hs.act(paused ? "resume" : "pause")}
                  />
                  <BarButton icon="📣" label={h.message} onClick={() => setSheet({ kind: "message", to: null })} />
                  <BarButton
                    icon="⚡"
                    label={no.events.button}
                    tone={snap.event && !snap.event.done ? "gold" : undefined}
                    onClick={() => setSheet({ kind: "events" })}
                  />
                  <BarButton
                    icon="🧲"
                    label={gathering ? h.endGather : h.gather}
                    tone={gathering ? "ok" : undefined}
                    onClick={() => void hs.act(gathering ? "end_gather" : "gather")}
                  />
                  <BarButton icon="⋯" label={h.more} onClick={() => setSheet({ kind: "more" })} />
                </>
              )}
            </div>
          </nav>
        )}
      </div>

      {/* tablet / PC: always-visible list */}
      <aside className="hidden h-dvh flex-col border-l border-line bg-ink-2 lg:flex">
        <div className="flex items-baseline justify-between gap-2 border-b border-line px-5 pt-5 pb-3">
          <h2 className="text-lg font-black">{h.playersList}</h2>
          <span className="text-sm font-bold text-txt-dim tabular-nums">
            {gathering ? h.gatherPanel.here(checkedIn, snap.players.length) : snap.players.length}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <PlayerList players={snap.players} status={snap.status} sosPlayers={sosPlayers} onSelect={select} act={hs.act} />
        </div>
      </aside>

      <Sheet open={!!sheet} onClose={closeSheet} title={sheet ? sheetTitle[sheet.kind] : undefined} closeLabel={h.close}>
        {sheet && (
          <div key={sheet.kind === "player" ? `p-${sheet.id}` : sheet.kind} className="m-fade-in">
            {sheet.kind === "player" && byId.get(sheet.id) && (
              <PlayerCard
                p={byId.get(sheet.id)!}
                status={snap.status}
                hs={hs}
                tagLive={(snap.status === "live" || snap.status === "paused") && snap.round?.mode === "tag"}
                awarded={(snap.referee_awards ?? []).includes(sheet.id)}
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
              <div className="flex flex-col items-center gap-4 py-2">
                {joinUrl && (
                  <div className="rounded-3xl bg-white p-4 shadow-[var(--shadow-card)]">
                    <QRCode value={joinUrl} size={240} />
                  </div>
                )}
                <p className="text-xs font-bold uppercase tracking-[0.2em] text-txt-dim">{h.pin}</p>
                <p className="-mt-3 font-mono text-5xl font-black tracking-[0.15em]">{snap.pin}</p>
              </div>
            )}
            {sheet.kind === "ceremony" && (
              <CeremonyStart
                onStart={async (spread) => {
                  if (await hs.act("ceremony_start", { spread })) setSheet(null);
                }}
              />
            )}
            {sheet.kind === "events" && <EventSheet snap={snap} hs={hs} />}
            {sheet.kind === "teams" && <TeamsSheet snap={snap} hs={hs} onSelect={select} />}
            {sheet.kind === "more" && (
              <div className="grid gap-2">
                {gathering && (
                  <SheetButton tone="gold" onClick={() => setSheet({ kind: "ceremony" })}>
                    {no.ceremony.start}
                  </SheetButton>
                )}
                <SheetButton onClick={() => setSheet({ kind: "qr" })}>▦ {h.showQr}</SheetButton>
                <a href={`/host/${hs.sessionId}/tavle`} target="_blank" rel="noopener" className={sheetBtn()} data-testid="open-screen">
                  {no.screen.open}
                </a>
                {qrCount > 0 && (
                  <Link href={`/host/${hs.sessionId}/poster`} className={sheetBtn()}>
                    {h.printQr(qrCount)}
                  </Link>
                )}
                <SheetButton onClick={() => setSheet({ kind: "players" })}>
                  👥 {h.playersList} <span className="ml-auto text-txt-dim tabular-nums">{snap.players.length}</span>
                </SheetButton>
                {(snap.plan?.teams ?? 0) >= 2 && <SheetButton onClick={() => setSheet({ kind: "teams" })}>{no.teams.host.title}</SheetButton>}
                <div className="my-1 h-px bg-line" aria-hidden />
                <SheetButton tone="danger" onClick={endFlow}>
                  ■ {h.endSession}
                </SheetButton>
              </div>
            )}
          </div>
        )}
      </Sheet>

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
  const [expanded, setExpanded] = useState(false);
  if (!alarms.length) return null;
  // Server order (unacked first, then sos › forbidden › outside › signal › speed) is kept.
  const groups = groupAlarms(alarms);
  // Always in sight, no tap needed (rule 4): the most severe row and every open SOS.
  const pinned = groups.filter((g, i) => i === 0 || (g.a.kind === "sos" && !g.a.acked));
  const rest = groups.filter((g) => !pinned.includes(g));
  const restOpen = rest.filter((g) => !g.a.acked).length;
  const shown = expanded ? groups : pinned;
  return (
    <ul className="pointer-events-auto max-h-[45dvh] space-y-1.5 overflow-y-auto overscroll-contain" aria-live="assertive" data-testid="alarm-strip">
      {shown.map(({ a, ids }, i) => {
        const urgent = !a.acked;
        const sos = a.kind === "sos";
        return (
          <li
            key={a.id}
            className={cx(
              "flex items-center gap-2 rounded-2xl py-1.5 pr-1.5 pl-4",
              urgent
                ? cx("bg-danger text-white shadow-[0_10px_30px_-10px_rgb(255_59_48/0.7)]", sos && "host-sos")
                : "host-float text-txt-dim",
            )}
          >
            <button className="min-h-12 min-w-0 flex-1 text-left" onClick={() => onFocus(a)}>
              <span className="block truncate font-black leading-tight">
                {sos ? "🆘 " : ""}
                {h.alarms[a.kind] ?? a.kind}
                {a.level >= 2 && a.kind === "outside" ? <span className="font-bold"> · {h.alarmHigh}</span> : null}
              </span>
              <span className={cx("block truncate text-sm font-bold", urgent ? "text-white/90" : "text-txt-dim")}>
                {a.nickname ?? "?"}
                {a.resolved ? ` · ${h.over}` : ""}
              </span>
            </button>
            {i === 0 && rest.length > 0 && (
              <button
                className={cx(
                  "ui-press relative min-h-12 min-w-12 shrink-0 rounded-xl px-3 text-sm font-black tabular-nums",
                  urgent ? "bg-white/20 text-white hover:bg-white/30" : "bg-ink-3 text-txt",
                )}
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                aria-label={expanded ? h.alarmLess : h.alarmMore(rest.length, restOpen)}
                data-testid="alarm-more"
              >
                {expanded ? "▲" : `+${rest.length}`}
                {!expanded && restOpen > 0 && (
                  <span className="absolute -top-1 -right-1 size-3 rounded-full border-2 border-danger bg-white" aria-hidden />
                )}
              </button>
            )}
            {urgent ? (
              <button className="ui-press min-h-12 shrink-0 rounded-xl bg-white px-4 text-sm font-black text-on-accent" onClick={() => onAck(ids)}>
                {h.ack}
              </button>
            ) : (
              <span className="shrink-0 px-2 text-xs font-bold">{h.seen}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Ids that were not in the previous list: only those rows pop in (not the whole list on every poll). */
function useFreshIds(ids: string[]): Set<string> {
  const key = ids.join(",");
  const [prevKey, setPrevKey] = useState(key);
  const [known, setKnown] = useState(() => new Set(ids));
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  if (prevKey !== key) {
    setPrevKey(key);
    setFresh(new Set(ids.filter((id) => !known.has(id))));
    setKnown(new Set(ids));
  }
  return fresh;
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
  // 0013: a big group lists only the phones that need help (GPS weak or missing).
  const [showAll, setShowAll] = useState(false);
  const crowd = players.length >= CROWD_FROM;
  const level = (p: HostPlayer) => (p.acc === null || p.signal === "none" || p.signal === "lost" ? 2 : p.acc < 15 ? 0 : p.acc <= 30 ? 1 : 2);
  const counts = [0, 0, 0];
  for (const p of players) counts[level(p)]++;
  const shown = crowd && !showAll ? players.filter((p) => level(p) > 0) : players;
  const fresh = useFreshIds(players.map((p) => p.id));
  const host = joinUrl.replace(/^https?:\/\//, "").replace(/\/\d+$/, "");
  return (
    <div className="h-full overflow-y-auto px-4 pt-20 pb-32 lg:px-8">
      <Card className="m-rise-in mx-auto flex max-w-3xl flex-col items-center gap-6 p-6 text-center sm:flex-row sm:items-center sm:gap-8 sm:p-8 sm:text-left">
        <div className="shrink-0 rounded-3xl border border-line bg-white p-3">
          {joinUrl ? <QRCode value={joinUrl} size={208} /> : <div className="size-[208px] rounded-xl bg-ink-3" />}
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-3xl font-black tracking-tight">{h.lobbyTitle}</h1>
          <p className="mt-1.5 text-txt-dim">
            {h.scan} <span className="font-bold whitespace-nowrap text-txt">{host}</span>
          </p>
          <p className="mt-5 text-xs font-bold uppercase tracking-[0.2em] text-txt-dim">{h.pin}</p>
          <p className="font-mono text-6xl font-black tracking-[0.12em] text-txt" data-testid="pin">
            {pin}
          </p>
          <span className="mt-1 block h-1 w-16 rounded-full bg-gold max-sm:mx-auto" aria-hidden />
        </div>
      </Card>

      {!!(plan?.rounds?.length || plan?.qr_posts) && (
        <div className="m-rise-in mx-auto mt-4 flex max-w-3xl flex-wrap items-center gap-2">
          {plan?.rounds?.length ? (
            <>
              <span className="mr-1 text-sm font-bold text-txt-dim">
                {h.round.playlist(plan.rounds.length, Math.round(planTotalS(plan) / 60))}
              </span>
              {plan.rounds.map((r, i) => (
                <span key={i} className="inline-flex items-center rounded-full bg-ink-2 px-3 py-1.5 text-xs font-bold shadow-[var(--shadow-card)]">
                  <span className="mr-1.5 text-txt-dim">{i + 1}</span>
                  {roundName(r)} · {Math.round(r.duration_s / 60)}′
                </span>
              ))}
            </>
          ) : null}
          {plan?.qr_posts ? (
            <Link href={`/host/${sessionId}/poster`} className={buttonClass("secondary", "md", "ml-auto")}>
              {h.printQr(plan.qr_posts)}
            </Link>
          ) : null}
        </div>
      )}

      <section className="mx-auto mt-8 max-w-3xl">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-extrabold" aria-live="polite">
            {players.length ? h.players(players.length) : h.waiting}
          </h2>
          {crowd && <span className="text-sm font-bold text-txt-dim">{no.crowd.summary(counts[0], counts[1], counts[2])}</span>}
        </div>
        {crowd && (
          <button className={buttonClass("secondary", "sm", "mt-2 min-h-12")} onClick={() => setShowAll((v) => !v)} data-testid="crowd-toggle">
            {showAll ? no.crowd.issuesOnly(counts[1] + counts[2]) : no.crowd.showAll(players.length)}
          </button>
        )}
        {!players.length && (
          <div className="mt-3 flex items-center gap-3 rounded-[var(--radius-card)] border border-dashed border-line px-4 py-5 text-txt-dim">
            <span className="size-2.5 animate-pulse rounded-full bg-gold" aria-hidden />
            {h.waiting}
          </div>
        )}
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {shown.map((p) => {
            const b = gpsBadge(p);
            return (
              <li key={p.id} className={fresh.has(p.id) ? "host-join" : undefined}>
                <button
                  className="ui-press flex min-h-14 w-full items-center justify-between gap-3 rounded-2xl bg-ink-2 px-4 py-2.5 text-left shadow-[var(--shadow-card)] hover:bg-ink-3"
                  onClick={() => onSelect(p.id)}
                >
                  <span className="truncate font-bold">{p.nickname}</span>
                  <Chip tone={b.tone}>{b.label}</Chip>
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

function gpsBadge(p: HostPlayer): { label: string; tone: "ok" | "warn" | "danger" } {
  if (p.acc === null || p.signal === "none" || p.signal === "lost") return { label: h.gps.none, tone: "danger" };
  if (p.acc < 15) return { label: `${h.gps.ok} ±${Math.round(p.acc)} m`, tone: "ok" };
  if (p.acc <= 30) return { label: `${h.gps.warn} ±${Math.round(p.acc)} m`, tone: "warn" };
  return { label: `${h.gps.bad} ±${Math.round(p.acc)} m`, tone: "danger" };
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
  const [q, setQ] = useState("");
  const crowd = players.length >= CROWD_FROM;
  const needle = q.trim().toLocaleLowerCase("nb");
  const list = crowd && needle ? players.filter((p) => p.nickname.toLocaleLowerCase("nb").includes(needle)) : players;
  return (
    <>
      {crowd && (
        <input
          className="mb-2 min-h-12 w-full rounded-[var(--radius-ctl)] border border-line bg-ink px-4 font-bold outline-none focus:border-gold-deep"
          placeholder={no.crowd.search}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label={no.crowd.search}
          data-testid="player-search"
        />
      )}
      {crowd && needle && list.length === 0 && <p className="px-1 text-sm text-txt-dim">{no.crowd.noMatch}</p>}
      <ul className="space-y-0.5">
        {list.map((p) => {
          const s = dotState(p, sosPlayers.has(p.id), status);
          return (
            <li key={p.id} className="flex min-h-12 items-center gap-3 rounded-xl px-3 transition-colors duration-[var(--dur-1)] hover:bg-ink-3">
              <span className="size-3.5 shrink-0 rounded-full border-2 shadow-sm" style={{ background: s.bg, borderColor: s.ring }} aria-hidden />
              <button className="flex min-h-12 min-w-0 flex-1 items-center gap-2 text-left" onClick={() => onSelect(p.id)}>
                <span className="truncate font-bold">{p.nickname}</span>
                <span className={cx("shrink-0 text-xs font-semibold", p.signal === "ok" ? "text-txt-dim" : "text-warn-text")}>
                  {h.card.signal[p.signal]}
                </span>
              </button>
              {gathering &&
                (p.checked_in ? (
                  <span className="text-sm font-black text-ok-text">✔</span>
                ) : (
                  <Button variant="ok" size="sm" className="min-h-10" onClick={() => void act("check_in", { player_id: p.id })}>
                    {h.card.checkIn}
                  </Button>
                ))}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function PlayerCard({
  p,
  status,
  hs,
  tagLive,
  awarded,
  onMessage,
  onShow,
  onKick,
}: {
  p: HostPlayer;
  status: Snapshot["status"];
  hs: HostSession;
  tagLive: boolean;
  awarded: boolean;
  onMessage: () => void;
  onShow: (lat: number, lng: number) => void;
  onKick: (p: HostPlayer) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(p.nickname);
  const [err, setErr] = useState<string | null>(null);
  const sitting = p.role === "sitting_out";
  const [adjusting, setAdjusting] = useState(false);
  const [delta, setDelta] = useState(5);
  const [reason, setReason] = useState("");
  const live = status !== "lobby" && status !== "ceremony" && status !== "ended";
  const points = useCountUp(p.points);
  const field = "min-h-12 rounded-[var(--radius-ctl)] border border-line bg-ink-2 px-4 font-bold outline-none focus:border-gold-deep";

  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        <Chip tone="neutral">{h.card.role[p.role] ?? p.role}</Chip>
        <Chip tone={p.signal !== "ok" ? "warn" : "ok"}>
          {h.card.signal[p.signal]}
          {p.acc !== null ? ` ${h.card.accuracy(p.acc)}` : ""}
          {p.fix_age_s !== null ? ` · ${h.card.age(p.fix_age_s)}` : ""}
        </Chip>
        <Chip tone={p.forbidden || p.geofence >= 2 ? "danger" : p.geofence >= 1 ? "warn" : "ok"}>
          {p.forbidden ? h.alarms.forbidden : h.card.geofence[p.geofence]}
          {p.geofence >= 2 ? ` · ${Math.round(p.outside_m)} m` : ""}
        </Chip>
        {p.still_s !== null && p.still_s > SAFETY.still_alert_s && status === "live" && <Chip tone="warn">{h.still(p.still_s)}</Chip>}
      </div>
      <dl className="mt-4 grid grid-cols-3 gap-2 text-center">
        <Stat label={h.card.distance} value={no.play.meters(p.distance_m)} />
        <Stat label={h.card.active} value={no.play.minutes(p.active_s)} />
        <Stat label={h.card.points} value={String(points)} />
      </dl>
      {(p.catches > 0 || p.times_caught > 0) && (
        <p className="mt-3 text-sm font-bold text-txt-dim">{h.card.tagStats(p.catches, p.times_caught)}</p>
      )}
      {(p.posts > 0 || p.badges > 0) && (
        <p className="mt-2 text-sm font-bold text-txt-dim">{h.card.extra(p.posts, p.badges, p.round_points)}</p>
      )}

      {renaming ? (
        <form
          className="m-rise-in mt-4 flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setErr(null);
            const ok = await hs.act("rename", { player_id: p.id, nickname: name.trim() });
            if (ok) setRenaming(false);
            else setErr(h.errors.nickname_taken);
          }}
        >
          <input className={cx(field, "min-w-0 flex-1")} value={name} maxLength={20} onChange={(e) => setName(e.target.value)} autoFocus />
          <button className={buttonClass("primary", "md")}>{h.card.save}</button>
        </form>
      ) : null}
      {adjusting && (
        <form
          className="m-rise-in mt-4 space-y-2.5 rounded-2xl bg-ink p-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!reason.trim()) return;
            if (await hs.act("adjust_points", { player_id: p.id, delta, reason: reason.trim() })) {
              setAdjusting(false);
              setReason("");
            }
          }}
          data-testid="adjust-form"
        >
          <div className="flex gap-1.5">
            {[-10, -5, 5, 10].map((d) => (
              <button
                key={d}
                type="button"
                className={cx(
                  "ui-press min-h-12 flex-1 rounded-xl font-black tabular-nums",
                  delta === d ? "bg-gold text-on-accent shadow-[var(--shadow-card)]" : "bg-ink-2 hover:bg-ink-3",
                )}
                onClick={() => setDelta(d)}
              >
                {d > 0 ? `+${d}` : d}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {h.card.adjustQuick.map((q) => (
              <button
                key={q}
                type="button"
                className={cx(
                  "ui-press min-h-10 rounded-full border px-3 text-xs font-bold",
                  reason === q ? "border-gold-deep bg-gold/20 text-txt" : "border-line bg-ink-2",
                )}
                onClick={() => setReason(q)}
              >
                {q}
              </button>
            ))}
          </div>
          <input className={cx(field, "w-full")} placeholder={h.card.adjustReason} value={reason} maxLength={80} onChange={(e) => setReason(e.target.value)} />
          <button className={buttonClass("primary", "md", "w-full")} disabled={!reason.trim()}>
            {h.card.adjustSave(delta)}
          </button>
        </form>
      )}
      {err && <p className="mt-2 text-sm font-semibold text-danger-text">{err}</p>}

      {hs.snap && status !== "ceremony" && (
        <div className="mt-4">
          <TeamMoveRow p={p} snap={hs.snap} hs={hs} />
        </div>
      )}

      <div className="mt-5 grid grid-cols-2 gap-2">
        {p.pos && <SheetButton onClick={() => onShow(p.pos!.lat, p.pos!.lng)}>📍 {h.card.showOnMap}</SheetButton>}
        <SheetButton onClick={onMessage}>📣 {h.card.sendMessage}</SheetButton>
        {status === "gathering" && (
          <SheetButton tone={p.checked_in ? undefined : "ok"} onClick={() => void hs.act("check_in", { player_id: p.id, checked: !p.checked_in })}>
            {p.checked_in ? h.card.uncheck : `✔ ${h.card.checkIn}`}
          </SheetButton>
        )}
        <SheetButton onClick={() => void hs.act("sit_out", { player_id: p.id, on: !sitting })}>
          {sitting ? `↩ ${h.card.sitIn}` : `🩹 ${h.card.sitOut}`}
        </SheetButton>
        <SheetButton onClick={() => setRenaming((r) => !r)}>✏️ {h.card.rename}</SheetButton>
        {live && <SheetButton onClick={() => setAdjusting((a) => !a)}>{h.card.adjust}</SheetButton>}
        {tagLive && p.role === "prey" && (
          <SheetButton onClick={() => void hs.act("set_role", { player_id: p.id, role: "hunter" })}>{h.card.makeHunter}</SheetButton>
        )}
        {tagLive && p.role === "hunter" && (
          <SheetButton onClick={() => void hs.act("set_role", { player_id: p.id, role: "prey" })}>{h.card.makePrey}</SheetButton>
        )}
        {status !== "ceremony" && (
          <SheetButton onClick={() => void hs.act("set_role", { player_id: p.id, role: p.role === "referee" ? "player" : "referee" })}>
            {p.role === "referee" ? h.card.backToPlay : h.card.makeReferee}
          </SheetButton>
        )}
        {status !== "ceremony" && (p.role === "referee" || awarded) && (
          <SheetButton
            onClick={async () => {
              setErr(null);
              if (!(await hs.act("referee_award", { player_id: p.id, on: !awarded })) && !awarded) setErr(h.card.awardFull);
            }}
          >
            {awarded ? h.card.unaward : h.card.award}
          </SheetButton>
        )}
        <SheetButton tone="danger" onClick={() => onKick(p)}>
          ✕ {h.card.kick}
        </SheetButton>
      </div>
    </div>
  );
}

function MessageSheet({ onSend }: { onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) onSend(text.trim());
      }}
    >
      <div className="flex flex-wrap gap-2">
        {h.msg.quick.map((q) => (
          <button key={q} type="button" className={buttonClass("secondary", "sm", "min-h-12 rounded-full px-4")} onClick={() => onSend(q)}>
            {q}
          </button>
        ))}
      </div>
      <div className="mt-4 flex gap-2">
        <input
          className="min-h-12 min-w-0 flex-1 rounded-[var(--radius-ctl)] border border-line bg-ink px-4 font-bold outline-none focus:border-gold-deep"
          placeholder={h.msg.placeholder}
          maxLength={200}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button className={buttonClass("primary", "md")} disabled={!text.trim()}>
          {h.msg.send}
        </button>
      </div>
    </form>
  );
}

function BarButton({
  icon,
  label,
  onClick,
  tone,
  wide,
  disabled,
}: {
  icon?: string;
  label: string;
  onClick: () => void;
  tone?: "gold" | "ok";
  wide?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      className={cx(
        "ui-press flex min-h-14 items-center justify-center rounded-2xl font-extrabold disabled:opacity-40",
        wide ? "col-span-2 gap-2 px-3 text-base" : "flex-col gap-1 px-1 text-[11px] leading-tight",
        tone === "gold"
          ? "bg-gold text-on-accent shadow-[var(--shadow-card)] hover:bg-gold-light"
          : tone === "ok"
            ? "bg-ok text-on-accent shadow-[var(--shadow-card)]"
            : "text-txt hover:bg-ink-3",
      )}
      onClick={onClick}
      disabled={disabled}
    >
      {icon && (
        <span className={cx("leading-none", wide ? "text-xl" : "text-lg")} aria-hidden>
          {icon}
        </span>
      )}
      <span className="text-center">{label}</span>
    </button>
  );
}

function sheetBtn(tone?: "danger" | "gold" | "ok") {
  return cx(
    "ui-press flex min-h-12 items-center gap-2 rounded-[var(--radius-ctl)] px-4 py-2.5 text-left font-bold",
    tone === "danger"
      ? "bg-danger/10 text-danger-text hover:bg-danger/15"
      : tone === "gold"
        ? "bg-gold text-on-accent shadow-[var(--shadow-card)] hover:bg-gold-light"
        : tone === "ok"
          ? "bg-ok/15 text-ok-text hover:bg-ok/20"
          : "bg-ink hover:bg-ink-3",
  );
}

function SheetButton({ children, onClick, tone }: { children: React.ReactNode; onClick: () => void; tone?: "danger" | "gold" | "ok" }) {
  return (
    <button className={sheetBtn(tone)} onClick={onClick}>
      {children}
    </button>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-ink px-2 py-3">
      <dt className="text-[11px] font-bold uppercase tracking-wide text-txt-dim">{label}</dt>
      <dd className="mt-0.5 text-xl font-black tabular-nums">{value}</dd>
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <main className="m-fade-in flex min-h-dvh flex-col items-center justify-center bg-ink px-6 text-center">{children}</main>;
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
  if (!r || snap.status === "lobby" || snap.status === "ceremony") return null;
  const status = h.status[snap.status] ?? snap.status;
  if (snap.playlist_done) {
    return (
      <div className="host-float m-drop-in pointer-events-auto flex items-center gap-3 rounded-2xl px-4 py-2.5" data-testid="round-bar">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-ok text-sm font-black text-on-accent" aria-hidden>
          ✔
        </span>
        <div className="min-w-0">
          <p className="text-sm font-extrabold leading-snug">{h.round.done}</p>
          <p className="truncate text-xs font-semibold text-txt-dim">
            {status} · PIN {snap.pin}
          </p>
        </div>
      </div>
    );
  }
  const left = phaseLeftS(r.phase_ends_at, offset, now);
  const live = snap.status === "live";
  const paused = snap.status === "paused";
  const between = snap.status === "countdown" || snap.status === "breather";
  const open = (snap.posts ?? []).filter((p) => !p.claimed_by).length;
  const taken = (snap.posts ?? []).filter((p) => p.claimed_by).length;
  const detail =
    live && r.mode === "posts"
      ? h.round.posts(open, taken)
      : live && r.mode === "tag"
        ? r.variant === "fox"
          ? h.round.foxCounts(snap.players.filter((p) => p.role === "hunter").length)
          : h.round.counts(snap.players.filter((p) => p.role === "hunter").length, snap.players.filter((p) => p.role === "prey").length)
        : live && r.relay
          ? h.round.relay((snap.teams ?? []).map((t) => `${t.name} ${r.relay?.legs[String(t.n)] ?? 0}`).join(" · "))
          : null;
  const sub = [h.round.of(r.idx + 1, r.count), live ? null : status, detail ?? `PIN ${snap.pin}`].filter(Boolean).join(" · ");
  const btn = "ui-press min-h-12 shrink-0 rounded-xl bg-ink-3 px-2.5 text-sm font-extrabold whitespace-nowrap hover:brightness-95";
  return (
    <div
      className={cx(
        "host-float pointer-events-auto flex items-center gap-2 rounded-2xl py-1.5 pr-1.5 pl-4 transition-shadow duration-[var(--dur-2)]",
        paused && "ring-2 ring-warn",
        snap.status === "gathering" && "ring-2 ring-ok",
      )}
      data-testid="round-bar"
    >
      <div className="min-w-0 flex-1 py-1">
        <p className="truncate text-sm font-extrabold leading-tight">{roundName(r)}</p>
        <p className={cx("truncate text-xs font-semibold", paused ? "text-warn-text" : "text-txt-dim")}>{sub}</p>
      </div>
      <span className="font-mono text-[1.4rem] font-black tabular-nums">{r.frozen ? "⏸" : formatClock(left)}</span>
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

/** «Start seremoni»: the spreading rule is on unless the teacher switches it off (PLAN §5.2). */
function CeremonyStart({ onStart }: { onStart: (spread: boolean) => void }) {
  const [spread, setSpread] = useState(true);
  return (
    <div className="space-y-4">
      <p className="text-txt-dim">{no.ceremony.introBody}</p>
      <label className="flex min-h-14 cursor-pointer items-center gap-3 rounded-[var(--radius-ctl)] bg-ink px-4 py-3 font-bold">
        <input type="checkbox" className="size-5 accent-[var(--color-gold-deep)]" checked={spread} onChange={(e) => setSpread(e.target.checked)} />
        {no.ceremony.spread}
      </label>
      <button className={buttonClass("primary", "xl", "w-full")} onClick={() => onStart(spread)} data-testid="ceremony-start">
        {no.ceremony.start}
      </button>
    </div>
  );
}
