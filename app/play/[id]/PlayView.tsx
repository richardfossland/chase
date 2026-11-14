"use client";

import "maplibre-gl/dist/maplibre-gl.css";

import type { Map as MlMap, Marker } from "maplibre-gl";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { ApiError, api, type PlayerBootstrap, type PostView, type RoundSummary, type TagView, type TickView } from "@/lib/client/api";
import { cue } from "@/lib/client/feedback";
import { QRCode } from "@/lib/client/QRCode";
import { QrScanner } from "@/lib/client/QrScanner";
import { identity, type StoredPlayer } from "@/lib/client/identity";
import { useDeviceGps, useSimGps, useWakeLock, vibrate, type Fix, type GpsState, type SimControls } from "@/lib/client/gps";
import { playBuzzer, playDing, unlockAudio } from "@/lib/client/sound";
import { useChannel } from "@/lib/client/useChannel";
import { no } from "@/lib/locale/no";
import { bearing, haversine } from "@/lib/geo";
import { addEventLayer, addMeLayer, addPostsLayer, addRadarLayer, addSessionLayers, addTeamLayer, addZoneLayer, boundsOf, setEvent, setMe, setPosts, setRadar, setTeam, setZone } from "@/lib/map/layers";
import { loadMapLibre } from "@/lib/map/maplibre";
import { kartverketStyle } from "@/lib/map/style";
import { channels } from "@/lib/realtime";
import { formatClock, phaseLeftS, type PlanRound } from "@/lib/rules/game";
import { catchQr, parseCatch } from "@/lib/rules/tag";
import { SAFETY } from "@/lib/rules/safety";
import { zoneAt, type ZoneNow, type ZoneState } from "@/lib/rules/zone";
import { EVENTS, nextBadgeToast, type Powerup } from "@/lib/rules/events";
import type { Badge } from "@/lib/rules/game";
import { EventStrip, PowerBar } from "./EventCard";
import { TeamMsgBar, TeamStrip } from "./TeamCard";
import { QuizCard } from "./QuizCard";
import { useTurn } from "./useTurn";
import { requestMotion, useStepCounter } from "@/lib/client/steps";
import { TEAMS, type TeamMsgKind } from "@/lib/rules/teams";
import { CeremonyScreen } from "@/lib/client/Ceremony";
import { parseQr } from "@/lib/qr";
import { Button, Toast, buttonClass, cx, prefersReducedMotion, useCountUp } from "@/lib/client/ui";

const t = no.play;

function roundTitle(r: { mode: string; variant?: string | null; zone?: unknown; zoned?: boolean; team?: boolean }): string {
  const base = r.mode === "tag" ? t.variants[r.variant ?? "convert"] : t.modes[r.mode];
  const teamed = r.team === true && r.mode !== "flag" && r.mode !== "king" && r.mode !== "relay" ? base + t.teamTag : base;
  return r.zoned || r.zone === true ? teamed + t.zoneTag : teamed;
}
const SIM_ALLOWED = process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_SIM_ENABLED === "1";
const FAST_MS = 2000; // active round / gathering (PLAN §9.2)
const SLOW_MS = 10000; // lobby / pause
const SOS_HOLD_MS = 1500;
const STALE_FIX_MS = 15000; // never send an old fix as if it were current

type Fatal = "lost" | "kicked" | "ended" | null;

export default function PlayView({ sessionId }: { sessionId: string }) {
  const params = useSearchParams();
  const simRequested = SIM_ALLOWED && params.get("simgps") === "1";

  const [me, setMeId] = useState<StoredPlayer | null | undefined>(undefined);
  const [boot, setBoot] = useState<PlayerBootstrap | null>(null);
  const [fatal, setFatal] = useState<Fatal>(null);

  useEffect(() => {
    const p = identity.player();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is client-only
    setMeId(p && p.sessionId === sessionId ? p : null);
  }, [sessionId]);

  useEffect(() => {
    if (!me) return;
    let cancelled = false;
    api
      .me(sessionId, me.playerId, me.token)
      .then((b) => !cancelled && setBoot(b))
      .catch((e) => {
        if (cancelled) return;
        const code = e instanceof ApiError ? e.code : "";
        if (code === "kicked") setFatal("kicked");
        else if (code === "auth" || code === "not_found") {
          identity.clearPlayer();
          setFatal("lost");
        } else setFatal("lost");
      });
    return () => {
      cancelled = true;
    };
  }, [me, sessionId]);

  if (me === undefined) return <main className="theme-dark min-h-dvh bg-ink" />;
  if (me === null || fatal === "lost") return <Fullscreen tone="neutral" title={t.sessionLost} link />;
  if (fatal === "kicked") return <Fullscreen tone="neutral" title={t.kicked} link />;
  if (!boot) return <Fullscreen tone="neutral" title={t.gpsSearching} />;

  return simRequested ? <SimGame me={me} boot={boot} /> : <DeviceGame me={me} boot={boot} />;
}

function DeviceGame(props: { me: StoredPlayer; boot: PlayerBootstrap }) {
  const gps = useDeviceGps();
  return <Game {...props} gps={gps} />;
}

function SimGame(props: { me: StoredPlayer; boot: PlayerBootstrap }) {
  const gps = useSimGps(props.boot.geo.assembly);
  return <Game {...props} gps={gps} sim={gps.sim} />;
}

function Game({ me, boot, gps, sim }: { me: StoredPlayer; boot: PlayerBootstrap; gps: GpsState; sim?: SimControls }) {
  const sessionId = boot.sessionId;
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<TickView | null>(null);
  const [ended, setEnded] = useState(false);
  const [kicked, setKicked] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [toast, setToast] = useState<{ id: number; text: string; label?: string } | null>(null);
  const [sosLocal, setSosLocal] = useState(false);
  const [sosDismissed, setSosDismissed] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ id: number; text: string; sub?: string; tone: "ok" | "gold" | "dim" } | null>(null);
  const [badgeToast, setBadgeToast] = useState<{ id: number; text: string } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const [catching, setCatching] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const [votedLocal, setVotedLocal] = useState(false);
  const [missionLocal, setMissionLocal] = useState<number | null>(null);   // «Ferdig» sent for this event no
  const [puBusy, setPuBusy] = useState(false);
  const [msgBusy, setMsgBusy] = useState(false);
  // 0012: step counter (opt-in on «Jeg er klar») and the question after a post.
  const [stepsOn, setStepsOn] = useState(false);
  const takeSteps = useStepCounter(stepsOn);
  const [quizBusy, setQuizBusy] = useState(false);
  const [quizDone, setQuizDone] = useState<number | null>(null);
  const [offsetMs, setOffsetMs] = useState(0); // server − client clock (rule 6: server time is the truth)

  const fixRef = useRef<Fix | null>(null);
  const inflight = useRef(false);
  const seenMsg = useRef<Set<number>>(new Set());
  const danger = useRef(false);
  const prev = useRef<TickView | null>(null);
  const seenGolden = useRef<Set<string>>(new Set());
  const seenTeamMsg = useRef<Set<string>>(new Set());
  const beeped = useRef<string>("");
  // Badge toasts: at most one per 30 s (ADR-024); the rest wait here.
  const badgeQueue = useRef<Badge[]>([]);
  const badgeSeen = useRef<Set<Badge>>(new Set());
  const lastBadgeAt = useRef<number | null>(null);
  const queueBadges = useCallback((list: Badge[]) => {
    for (const b of list) {
      if (badgeSeen.current.has(b)) continue;
      badgeSeen.current.add(b);
      badgeQueue.current.push(b);
    }
  }, []);

  useEffect(() => {
    fixRef.current = gps.fix;
  }, [gps.fix]);

  useWakeLock(ready && !ended);

  // The session is over: forget this device's identity (PLAN §8 — nothing lingers).
  useEffect(() => {
    if (ended || kicked) identity.clearPlayer();
  }, [ended, kicked]);

  // 1 s clock for "GPS lost" and the toast.
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);

  // Game feedback for one tick response (sound + vibration + flash).
  // Safety cues (buzzer in the effect below) always win.
  const react = useCallback((view: TickView) => {
    const p = prev.current;
    prev.current = view;
    if (view.claimed) {
      const gold = view.claimed.kind === "golden";
      cue(gold ? "golden" : "claim");
      setFlash({ id: Date.now(), text: t.claimed(view.claimed.value), sub: gold ? t.goldenClaimed : undefined, tone: gold ? "gold" : "ok" });
    } else if (view.lost) {
      cue("lost");
      setFlash({ id: Date.now(), text: t.lost, tone: "dim" });
    }
    for (const post of view.posts ?? []) {
      if (post.kind !== "golden" || seenGolden.current.has(post.id)) continue;
      seenGolden.current.add(post.id);
      if (!view.claimed) cue("golden");
      setToast({ id: Date.now(), text: t.golden });
    }
    // Every badge the server stored since the last tick — also those from the
    // teacher's mission confirmation or another request (0007).
    if (!p) view.stats.badges.forEach((b) => badgeSeen.current.add(b));
    else queueBadges(view.stats.badges.filter((b) => !p.stats.badges.includes(b)));
    if (view.new_badges?.length) queueBadges(view.new_badges);
    // Events (0007): a new one gets attention; my result gets a flash.
    const ev = view.event ?? null;
    const pev = p?.event ?? null;
    if (ev && !ev.done && (!pev || pev.no !== ev.no)) {
      cue("golden");
      setToast({ id: Date.now(), text: no.events.kinds[ev.kind], label: no.events.title });
    }
    if (ev?.me && (!pev || pev.no !== ev.no || pev.me?.state !== ev.me.state) && ev.me.state !== "pending") {
      cue("claim");
      setFlash({
        id: Date.now(),
        text: `+${ev.me.points}`,
        sub: ev.me.powerup ? no.events.gotPowerup(no.events.powerups[ev.me.powerup]) : no.events.kinds[ev.kind],
        tone: "gold",
      });
    }
    const storm = ev?.kind === "storm" || pev?.kind === "storm";
    // Smittejakt: my role flipped without me catching anyone → I was caught (not a storm swap).
    if (!storm && p && p.status === "live" && view.status === "live" && p.role === "prey" && view.role === "hunter") {
      cue("caught");
      setFlash({ id: Date.now(), text: t.caughtYou, sub: t.nowHunter, tone: "dim" });
    }
    if (view.tag?.hunter_near && !p?.tag?.hunter_near) cue("danger");
    // 0013 Sporing: I caught the fox → I am the fox now.
    if (!storm && view.tag?.fox && p && p.status === "live" && view.status === "live" && p.role === "hunter" && view.role === "prey") {
      cue("golden");
      setFlash({ id: Date.now(), text: no.fox.became, tone: "gold" });
    }
    // 0013 Stafett: post reached, leg done.
    if (view.relay && p?.relay && p.round?.idx === view.round?.idx) {
      if (view.relay.back && !p.relay.back && view.relay.post !== null) {
        cue("claim");
        setFlash({ id: Date.now(), text: no.relay.postTaken(5), tone: "ok" });
      } else if (view.relay.legs > p.relay.legs) {
        cue("golden");
        setToast({ id: Date.now(), text: no.relay.legDone, label: no.relay.title });
      } else if (view.relay.post !== null && p.relay.post === null) {
        cue("go");
        setToast({ id: Date.now(), text: no.relay.run, label: no.relay.title });
      }
    }
    // Ceremony: fanfare on every reveal, extra buzz when it is me.
    if (view.ceremony && p?.ceremony && view.ceremony.step > p.ceremony.step && view.ceremony.step <= view.ceremony.total) {
      const latest = view.ceremony.revealed[view.ceremony.revealed.length - 1];
      cue("reveal");
      if (latest?.entries.some((e) => e.me)) setTimeout(() => cue("badge"), 600);
    }
    // Krympende sone: +5 for being inside at a shrink, alarm tone when I drop out.
    if (view.zone && p?.zone && view.status === "live") {
      if (view.zone.hits > p.zone.hits) {
        cue("claim");
        setFlash({ id: Date.now(), text: "+5", sub: t.zoneBonus, tone: "ok" });
      } else if (!view.zone.inside && p.zone.inside) cue("danger");
    }
    // Teams (0009): teammates' quick messages, flags won/lost, the hill moving.
    const myTeam = view.team?.n;
    for (const m of view.team?.msgs ?? []) {
      const key = `${m.nickname}|${m.at}`;
      if (seenTeamMsg.current.has(key)) continue;
      seenTeamMsg.current.add(key);
      if (m.me || !p) continue;
      setToast({ id: Date.now(), text: no.teams.msgFrom(m.nickname, no.teams.msgs[m.kind] ?? m.kind), label: no.teams.msgTitle });
      playDing();
      vibrate(m.kind === "help" ? [200, 100, 200] : 150);
    }
    const pFlags = p?.round?.idx === view.round?.idx ? (p?.round?.flags ?? []) : [];
    for (const f of view.round?.flags ?? []) {
      const was = pFlags.find((x) => x.n === f.n)?.owner ?? null;
      if (myTeam === undefined || !p || was === f.owner) continue;
      if (f.owner === myTeam) {
        cue("golden");
        setFlash({ id: Date.now(), text: no.teams.flagWon, tone: "gold" });
      } else if (was === myTeam) {
        cue("lost");
        setToast({ id: Date.now(), text: no.teams.flagLost, label: no.teams.msgTitle });
      }
    }
    if (view.round?.hill && p?.round?.hill && p.round.idx === view.round.idx && view.round.hill.no > p.round.hill.no) {
      cue("golden");
      setToast({ id: Date.now(), text: no.teams.hillMoved, label: no.teams.msgTitle });
    }
    if (p && p.status !== view.status) {
      if (view.status === "live" && (p.status === "countdown" || p.status === "breather")) cue("go");
      if (p.status === "live" && (view.status === "breather" || view.status === "gathering")) cue("roundEnd");
    }

  }, [queueBadges]);

  const tickNow = useCallback(async () => {
    const f = fixRef.current;
    if (!f || inflight.current || Date.now() - f.at > STALE_FIX_MS) return;
    inflight.current = true;
    try {
      const v = await api.tick(sessionId, {
        playerId: me.playerId,
        token: me.token,
        lat: f.lat,
        lng: f.lng,
        acc: f.acc,
        speed: f.speed,
        ts: Date.now(), // send time: orders requests; the same fix may be re-sent while standing still
        steps: takeSteps() || undefined,
      });
      setOffsetMs(Date.parse(v.server_now) - Date.now());
      setView(v);
      react(v);
      if (v.status === "ended") setEnded(true);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "";
      if (code === "ended") setEnded(true);
      else if (code === "kicked") setKicked(true);
      // network/timeout/stale: the next tick tries again
    } finally {
      inflight.current = false;
    }
  }, [me.playerId, me.token, sessionId, react, takeSteps]);

  const status = view?.status ?? boot.status;
  const fast = status === "live" || status === "gathering" || status === "countdown" || status === "ceremony";

  useEffect(() => {
    if (!ready || ended || kicked) return;
    const first = setTimeout(tickNow, 0);
    const iv = setInterval(tickNow, fast ? FAST_MS : SLOW_MS);
    return () => {
      clearTimeout(first);
      clearInterval(iv);
    };
  }, [ready, ended, kicked, fast, tickNow]);

  // First fix after «Jeg er klar»: report at once instead of waiting a full interval.
  const hasFix = gps.fix !== null;
  useEffect(() => {
    if (ready && hasFix && !view) void tickNow();
  }, [ready, hasFix, view, tickNow]);

  // Push hints → fetch truth immediately.
  const onHint = useCallback(() => void tickNow(), [tickNow]);
  useChannel(ready ? channels.all(sessionId) : null, onHint);
  useChannel(ready ? channels.player(sessionId, me.playerId) : null, onHint);

  // Tick the moment the current phase ends (countdown → round → breather), so
  // the screen flips with the server instead of on the next 10 s interval.
  const phaseEnds = view?.round?.frozen ? null : (view?.round?.phase_ends_at ?? null);
  useEffect(() => {
    if (!ready || !phaseEnds) return;
    const ms = Date.parse(phaseEnds) - (Date.now() + offsetMs) + 300;
    if (ms < 0 || ms > 30 * 60_000) return;
    const tm = setTimeout(() => void tickNow(), ms);
    return () => clearTimeout(tm);
  }, [ready, phaseEnds, offsetMs, tickNow]);

  // Back from a locked screen (breather in the pocket): report as soon as GPS has a fresh fix.
  useEffect(() => {
    if (!ready) return;
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      unlockAudio();
      setTimeout(() => void tickNow(), 1500);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [ready, tickNow]);

  // Feedback: buzzer + vibration when entering danger; ding for new messages.
  useEffect(() => {
    if (!view) return;
    const isDanger = view.safety.forbidden || view.safety.geofence >= 2;
    if (isDanger && !danger.current) {
      playBuzzer();
      vibrate([300, 150, 300]);
    }
    danger.current = isDanger;

    for (const m of view.messages) {
      if (seenMsg.current.has(m.id)) continue;
      seenMsg.current.add(m.id);
      setToast({ id: m.id, text: m.text });
      playDing();
      vibrate(200);
    }
  }, [view]);

  useEffect(() => {
    if (!toast) return;
    const tm = setTimeout(() => setToast(null), 8000);
    return () => clearTimeout(tm);
  }, [toast]);
  useEffect(() => {
    if (!flash) return;
    const tm = setTimeout(() => setFlash(null), 1600);
    return () => clearTimeout(tm);
  }, [flash]);
  useEffect(() => {
    if (!badgeToast) return;
    const tm = setTimeout(() => setBadgeToast(null), 5000);
    return () => clearTimeout(tm);
  }, [badgeToast]);

  // 3-2-1 beeps at the end of the countdown (from server time).
  const leftNow = phaseLeftS(view?.round?.phase_ends_at, offsetMs, now);
  useEffect(() => {
    if (status !== "countdown" || leftNow === null || leftNow < 1 || leftNow > 3) return;
    const key = `${view?.round?.idx}:${leftNow}`;
    if (beeped.current === key) return;
    beeped.current = key;
    cue("beep");
  }, [status, leftNow, view?.round?.idx]);

  // Zone: one beep when the next circle is announced (20 s before), from server time.
  const zoneState: ZoneState | null = view && (view.status === "live" || view.status === "paused") ? (view.round?.zone ?? null) : null;
  const zn: ZoneNow | null = zoneState ? zoneAt(zoneState, now + offsetMs) : null;
  const zoneWarnKey = zn?.warn && view?.status === "live" ? `${view.round?.idx}:${zn.phase}` : null;
  const zoneWarned = useRef<string | null>(null);
  useEffect(() => {
    if (!zoneWarnKey || zoneWarned.current === zoneWarnKey) return;
    zoneWarned.current = zoneWarnKey;
    cue("beep");
  }, [zoneWarnKey]);

  const onCatch = useCallback(
    async (text: string) => {
      const code = parseCatch(text);
      if (!code || scanBusy) {
        if (!code) setFlash({ id: Date.now(), text: t.catchErr.bad_code, tone: "dim" });
        return;
      }
      setScanBusy(true);
      try {
        const r = await api.catch(sessionId, { playerId: me.playerId, token: me.token, code });
        setCatching(false);
        cue("claim");
        setFlash({
          id: Date.now(),
          text: t.caught(r.nickname, r.points),
          sub: r.last ? t.lastCaught : r.variant === "swap" ? t.nowPrey : undefined,
          tone: "ok",
        });
        queueBadges(r.newBadges);
        void tickNow();
      } catch (e) {
        const c = e instanceof ApiError ? e.code : "";
        setFlash({ id: Date.now(), text: t.catchErr[c] ?? t.qrError, tone: "dim" });
      } finally {
        setTimeout(() => setScanBusy(false), 1200);
      }
    },
    [me.playerId, me.token, scanBusy, sessionId, tickNow, queueBadges],
  );

  const onScan = useCallback(
    async (text: string) => {
      const code = parseQr(text, sessionId);
      if (!code || scanBusy) {
        if (!code) setFlash({ id: Date.now(), text: t.qrBad, tone: "dim" });
        return;
      }
      setScanBusy(true);
      try {
        const r = await api.qr(sessionId, { playerId: me.playerId, token: me.token, code });
        setScanning(false);
        if (r.already) {
          setFlash({ id: Date.now(), text: t.qrPost(r.n), sub: r.mission ? no.events.kinds.mission : t.qrAlready, tone: "dim" });
        } else {
          cue("claim");
          setFlash({ id: Date.now(), text: t.qrOk(r.value, r.first), sub: r.mission ? no.events.confirmed(r.value) : t.qrPost(r.n), tone: "ok" });
          queueBadges(r.newBadges);
        }
        void tickNow();
      } catch (e) {
        const code2 = e instanceof ApiError ? e.code : "";
        setFlash({
          id: Date.now(),
          text: code2 === "bad_code" ? t.qrBad : code2 === "not_now" ? t.qrNotNow : t.qrError,
          tone: "dim",
        });
      } finally {
        setTimeout(() => setScanBusy(false), 1200);   // don't re-scan the same card instantly
      }
    },
    [me.playerId, me.token, scanBusy, sessionId, tickNow, queueBadges],
  );

  // Badge queue → one toast per badge_gap_s (the 1 s clock drives it).
  useEffect(() => {
    const { show, rest } = nextBadgeToast(badgeQueue.current, lastBadgeAt.current, now);
    if (!show) return;
    badgeQueue.current = rest;
    lastBadgeAt.current = now;
    cue("badge");
    setBadgeToast({ id: now, text: t.badges[show] ?? show });
  }, [now]);

  const firePowerup = useCallback(
    async (kind: Powerup) => {
      if (puBusy) return;
      setPuBusy(true);
      unlockAudio();
      try {
        const r = await api.powerup(sessionId, { playerId: me.playerId, token: me.token, kind });
        cue("claim");
        setFlash({ id: Date.now(), text: no.events.powerups[kind], sub: no.events.powerupHelp[kind], tone: "gold" });
        queueBadges(r.newBadges);
        void tickNow();
      } catch (e) {
        const c = e instanceof ApiError ? e.code : "";
        setFlash({ id: Date.now(), text: no.events.puErrors[c] ?? t.qrError, tone: "dim" });
      } finally {
        setPuBusy(false);
      }
    },
    [me.playerId, me.token, puBusy, sessionId, tickNow, queueBadges],
  );

  const sendTeamMsg = useCallback(
    async (kind: TeamMsgKind) => {
      if (msgBusy) return;
      setMsgBusy(true);
      unlockAudio();
      try {
        await api.teamMsg(sessionId, { playerId: me.playerId, token: me.token, kind });
        cue("claim");
        void tickNow();
      } catch (e) {
        const c = e instanceof ApiError ? e.code : "";
        setFlash({ id: Date.now(), text: no.teams.msgErrors[c] ?? t.qrError, tone: "dim" });
      } finally {
        // One message per msg_gap_s (the server enforces it too).
        setTimeout(() => setMsgBusy(false), TEAMS.msg_gap_s * 1000);
      }
    },
    [me.playerId, me.token, msgBusy, sessionId, tickNow],
  );

  const sendMissionDone = useCallback(
    async (evNo: number) => {
      setMissionLocal(evNo);
      try {
        await api.missionDone(sessionId, { playerId: me.playerId, token: me.token });
        void tickNow();
      } catch (e) {
        setMissionLocal(null);
        const c = e instanceof ApiError ? e.code : "";
        setFlash({ id: Date.now(), text: no.events.errors[c] ?? t.qrError, tone: "dim" });
      }
    },
    [me.playerId, me.token, sessionId, tickNow],
  );

  // Server says acked → local "sent" state ends; the green receipt closes itself after 10 s.
  const ackedId = view?.sos?.acked ? view.sos.id : null;
  useEffect(() => {
    if (!ackedId) return;
    const first = setTimeout(() => setSosLocal(false), 0);
    const close = setTimeout(() => setSosDismissed(ackedId), 10_000);
    return () => {
      clearTimeout(first);
      clearTimeout(close);
    };
  }, [ackedId]);

  async function sendSos() {
    setSosLocal(true);
    vibrate([100, 50, 100]);
    const f = fixRef.current;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await api.sos(sessionId, { playerId: me.playerId, token: me.token, lat: f?.lat, lng: f?.lng });
        void tickNow();
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }

  // «GO!» when a round starts (countdown/breather → live), from the server status.
  const [prevStatus, setPrevStatus] = useState(status);
  const [goKey, setGoKey] = useState(0);
  if (prevStatus !== status) {
    setPrevStatus(status);
    if (status === "live" && (prevStatus === "countdown" || prevStatus === "breather")) setGoKey(goKey + 1);
  }
  // Points tick up and bump when they rise. Display only: the server value is the truth.
  const pts = view?.stats.points ?? 0;
  const shownPts = useCountUp(pts);
  const [prevPts, setPrevPts] = useState(pts);
  const [ptsBump, setPtsBump] = useState(0);
  if (prevPts !== pts) {
    setPrevPts(pts);
    if (pts > prevPts) setPtsBump(ptsBump + 1);
  }
  const msgToast = useMemo(() => (toast ? { ...toast, label: toast.label ?? t.message } : null), [toast]);
  const badgeToastView = useMemo(() => (badgeToast ? { ...badgeToast, label: t.newBadge } : null), [badgeToast]);

  if (kicked) return <Fullscreen tone="neutral" title={t.kicked} link />;
  if (ended) {
    return <Fullscreen tone="neutral" title={t.ended} body={t.endedBody} link />;
  }

  if (!ready) {
    return (
      <ReadyScreen
        name={me.nickname}
        error={gps.error}
        onReady={() => {
          unlockAudio();
          gps.start();
          setReady(true);
          // iOS asks for motion access only from a tap; a «no» just leaves the counter off.
          void requestMotion().then(setStepsOn);
        }}
      />
    );
  }
  if (gps.error === "denied") {
    return <DeniedHelp onRetry={() => gps.start()} />;
  }

  const fixAge = gps.fix ? now - gps.fix.at : Infinity;
  const gpsLost = fixAge > SAFETY.signal_uncertain_s * 1000;
  const sosOpen = sosLocal || (view?.sos && !view.sos.acked);
  const sosAcked = !!view?.sos?.acked && view.sos.id !== sosDismissed;

  const round = view?.round ?? null;
  const mode = round?.mode ?? "free";
  const left = phaseLeftS(round?.phase_ends_at, offsetMs, now);
  const posts = status === "live" || status === "paused" ? (view?.posts ?? []) : [];
  const nearest = nearestPost(gps.fix, posts);
  const summary = view?.summary ?? null;
  const playlistDone = status === "gathering" && !!summary && !!round && round.idx === round.count - 1;
  const tag: TagView | null = (status === "live" || status === "paused") && mode === "tag" ? (view?.tag ?? null) : null;
  const role = view?.role;
  const isHunter = !!tag && role === "hunter";
  const isPrey = !!tag && role === "prey";
  const immuneLeft = tag?.immune_until ? phaseLeftS(tag.immune_until, offsetMs, now) : null;
  const zoneOut = status === "live" && !!zn && view?.zone?.inside === false;
  const evView = view?.event ?? null;
  const team = view?.team ?? null;
  const teamLive = (status === "live" || status === "paused") && !!round?.team;
  const teamMap = team && teamLive
    ? JSON.stringify({
        palette: team.palette,
        flags: round?.flags ?? null,
        hill: round?.hill ? { pos: round.hill.pos, r: round.hill.r, holder: round.hill.holder } : null,
        mates: team.mates ?? [],
        mateColor: team.color,
        relay: round?.relay
          ? { base: round.relay.base, r: round.relay.r, posts: round.relay.posts,
              target: !view?.relay || view.relay.post === null ? null : view.relay.back ? "base" : view.relay.post }
          : null,
        msgs: (team.msgs ?? []).filter((m) => !m.me).map((m) => ({ label: `${m.nickname}: ${no.teams.msgsPlain[m.kind] ?? ""}`, pos: m.pos })),
      })
    : null;
  // 0013 Sporing: the fox sees the hunters near it (same dots as the radar power-up).
  const foxLive = isPrey && tag?.fox ? (tag.hunter_pos ?? []).map((h) => h.pos) : null;
  const sprintTarget = evView && !evView.done && evView.kind === "sprint" && !evView.me ? evView.target : null;
  const zoneEdge = zn && zoneState && gps.fix
    ? { m: Math.max(0, Math.round(haversine([gps.fix.lng, gps.fix.lat], [zoneState.c.lng, zoneState.c.lat]) - zn.r)),
        deg: bearing([gps.fix.lng, gps.fix.lat], [zoneState.c.lng, zoneState.c.lat]) }
    : null;

  // Banner: one main message, most urgent first (safety beats game).
  let tone: Tone = "neutral";
  let title: string = t.lobby;
  let body: string | undefined = t.lobbyHint;
  if (status === "countdown" && round) {
    tone = "warn";
    title = t.countdown;
    body = `${t.roundOf(round.idx + 1, round.count)} · ${roundTitle(round)}`;
  }
  if (status === "live" && isHunter && tag?.fox) {
    // 0013 Sporing: everybody hunts the one fox.
    tone = "hunter";
    title = no.fox.hunt;
    body = tag.prey_near ? t.preyNear(tag.prey_near) : tag.radar?.length ? no.fox.seen(Math.min(...tag.radar.map((r) => r.age_s))) : t.modeHint.fox;
  } else if (status === "live" && isPrey && tag?.fox) {
    tone = "live";
    title = no.fox.you;
    body = immuneLeft ? t.immune(immuneLeft) : tag.hunter_pos?.length ? no.fox.hunters(tag.hunter_pos.length) : no.fox.noHunters;
  } else if (status === "live" && isHunter && tag) {
    tone = "hunter";
    title = t.hunter;
    body = tag.prey_near ? t.preyNear(tag.prey_near) : t.hunterHint;
  } else if (status === "live" && isPrey && tag) {
    tone = "live";
    title = t.prey;
    body = immuneLeft ? t.immune(immuneLeft) : tag.hunter_near ? t.hunterNear : t.preyHint;
  } else if (status === "live") {
    tone = "live";
    title = roundTitle(round ?? { mode });
    body =
      view?.claim ? t.claiming
      : mode === "posts" && nearest ? undefined // the compass below says it
      : left !== null && round && left > round.duration_s - 10 ? t.modeHint[mode]
      : undefined;
  }
  if (status === "breather") {
    tone = "pause";
    title = t.breather;
    body = t.breatherBody;
  }
  if (status === "paused") {
    tone = "pause";
    title = t.paused;
    body = t.pausedBody;
  }
  if (status === "gathering" && view?.gather) {
    tone = view.gather.checked_in ? "ok" : "warn";
    title = view.gather.checked_in ? t.checkedIn : playlistDone ? t.done : t.gather;
    body = view.gather.checked_in ? undefined : t.gatherBody(view.gather.distance_m);
  }
  if (view && status !== "lobby") {
    if (view.safety.geofence === 1 && tone !== "warn") {
      tone = "edge";
      body = t.nearEdge;
    }
    if (view.safety.geofence >= 2) {
      tone = "danger";
      title = t.outside;
      body = t.outsideBody;
    }
    if (view.safety.forbidden) {
      tone = "danger";
      title = t.forbidden;
      body = t.forbiddenBody;
    }
  }

  // Safety tones (danger, near the edge) switch instantly: no colour fade, no entrance animation.
  const safetyTone = tone === "danger" || tone === "edge";
  const showCompass = status === "live" && mode === "posts" && !!nearest && !view?.claim && !safetyTone;

  return (
    <div className={cx("theme-dark relative flex h-dvh flex-col", TONE_BG[tone], !safetyTone && "m-tone")}>
      <header className="px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3">
        <div className="flex items-center justify-between text-sm font-bold">
          <span>{me.nickname}</span>
          <GpsChip fix={gps.fix} lost={gpsLost} />
        </div>
        <h1 key={title} className={cx("mt-3 text-5xl font-black leading-none tracking-tight", !safetyTone && "m-rise-in")} data-testid="play-title">
          {title}
        </h1>
        {body && <p className="mt-2 text-lg font-bold opacity-90">{body}</p>}
        {gpsLost && <p className="mt-2 rounded-xl bg-black/30 px-3 py-2 font-bold">{t.gpsLost}</p>}
        {showCompass && nearest && (
          <Compass m={nearest.m} deg={nearest.deg} label={t.nearestPost(nearest.m, t.dirs[Math.round(nearest.deg / 45) % 8])} />
        )}
        {status === "countdown" && left !== null && (
          <p className="mt-2 text-8xl font-black tabular-nums leading-none" data-testid="countdown">
            <span key={left} className="m-pop inline-block">
              {left}
            </span>
          </p>
        )}
        {view && status !== "countdown" && (
          <dl className="mt-3 flex items-end gap-5">
            <div>
              <dt className="text-xs font-bold uppercase opacity-70">{t.points}</dt>
              <dd className="text-4xl font-black tabular-nums" data-testid="points">
                <span key={ptsBump} className={cx("inline-block origin-left", ptsBump > 0 && "m-bump")}>
                  {shownPts}
                </span>
              </dd>
            </div>
            {round && (status === "live" || status === "paused" || status === "breather") && (
              <div>
                <dt className="text-xs font-bold uppercase opacity-70">{status === "breather" ? t.breather : t.timeLeft}</dt>
                <dd className="text-4xl font-black tabular-nums" data-testid="clock">{formatClock(left)}</dd>
              </div>
            )}
            <div className="ml-auto text-right text-sm font-bold opacity-90">
              <p>{t.meters(view.stats.distance_m)}</p>
              <p>{t.minutes(view.stats.active_s)} {t.active.toLowerCase()}</p>
              {view.stats.posts > 0 && <p>{t.postsN(view.stats.posts)}</p>}
              {stepsOn && (view.stats.steps ?? 0) > 0 && (
                <p>
                  {view.stats.steps} {no.steps.label.toLowerCase()}
                </p>
              )}
            </div>
          </dl>
        )}
      </header>

      {tag && (
        <div className="flex items-center justify-between gap-2 px-4 pb-2 text-sm font-bold">
          <span className="opacity-90">{tag.fox ? no.host.round.foxCounts(tag.hunters) : t.counts(tag.hunters, tag.prey)}</span>
          {isPrey && tag.code && (
            <button className="rounded-full bg-black/30 px-3 py-1 font-mono font-black tracking-widest" onClick={() => setShowCode(true)}>
              {t.yourCode} {tag.code}
            </button>
          )}
          {isHunter && tag.blackout ? <span className="opacity-90">{no.events.blackout}</span>
            : isHunter && tag.radar?.length ? <span className="opacity-80">{t.radarAge(Math.min(...tag.radar.map((r) => r.age_s)))}</span> : null}
        </div>
      )}

      {zn && status === "live" && (zoneOut || zn.warn) && (
        <div
          className={`mx-4 mb-2 flex items-center gap-3 rounded-xl px-3 py-2 font-black ${zoneOut ? "bg-danger text-white" : "bg-black/40"}`}
          role="status"
          data-testid="zone-strip"
        >
          {zoneOut && zoneEdge && (
            <span className="inline-block text-3xl leading-none" style={{ transform: `rotate(${zoneEdge.deg}deg)` }} aria-hidden>
              ↑
            </span>
          )}
          <span className="flex-1">{zoneOut ? t.zoneOut : t.zoneShrinkIn(zn.next?.inS ?? 0)}</span>
          {zoneOut && zoneEdge && <span className="tabular-nums">{t.zoneTo(zoneEdge.m)}</span>}
        </div>
      )}

      {team && status !== "ceremony" && (
        <TeamStrip team={team} round={round} fix={gps.fix} offsetMs={offsetMs} now={now} live={teamLive} relay={view?.relay ?? null} />
      )}
      {team && teamLive && status === "live" && <TeamMsgBar busy={msgBusy} onSend={(k) => void sendTeamMsg(k)} />}

      {evView && (status === "live" || status === "paused") && (
        <EventStrip
          key={evView.no}
          ev={evView}
          fix={gps.fix}
          offsetMs={offsetMs}
          now={now}
          qr={!!round?.qr}
          pendingLocal={missionLocal === evView.no}
          onDone={() => void sendMissionDone(evView.no)}
          onScan={() => {
            unlockAudio();
            setScanning(true);
          }}
        />
      )}
      {view?.power && (status === "live" || status === "paused") && (
        <PowerBar power={view.power} round={round} role={role} offsetMs={offsetMs} now={now} busy={puBusy} onUse={(k) => void firePowerup(k)} />
      )}

      <div
        className={`relative min-h-0 flex-1 ${
          zoneOut ? "ring-[10px] ring-inset ring-danger animate-pulse"
          : tag?.hunter_near && !immuneLeft ? "ring-[10px] ring-inset ring-hunter animate-pulse" : ""
        }`}
      >
        <PlayerMap
          boot={boot}
          fix={gps.fix}
          posts={posts}
          activeId={view?.claim?.post_id ?? null}
          radar={isHunter ? (tag?.radar ?? []) : []}
          zoneLat={zoneState?.c.lat ?? null}
          zoneLng={zoneState?.c.lng ?? null}
          zoneR={zn?.r ?? null}
          zoneNextR={zn?.warn ? (zn.next?.r ?? null) : null}
          targetLat={sprintTarget?.lat ?? null}
          targetLng={sprintTarget?.lng ?? null}
          live={foxLive ?? tag?.radar_live ?? NO_LIVE}
          teamMap={teamMap}
          pulseLat={showCompass && nearest ? nearest.lat : null}
          pulseLng={showCompass && nearest ? nearest.lng : null}
          activePos={view?.claim ? (posts.find((p) => p.id === view.claim?.post_id)?.pos ?? null) : null}
        />
        {sim && <SimPad sim={sim} />}
        {goKey > 0 && status === "live" && (
          <div className="pointer-events-none absolute inset-0 z-[5] grid place-items-center" aria-hidden>
            <p key={goKey} className="p-go text-[7.5rem] font-black italic leading-none text-white [text-shadow:0_6px_30px_rgb(0_0_0/0.45)]">
              {t.go}
            </p>
          </div>
        )}
        {summary && (status === "breather" || status === "gathering") && (
          <SummaryCard summary={summary} next={status === "breather" ? (round?.next ?? null) : null} />
        )}
      </div>

      {status === "ceremony" && view?.ceremony && (
        <div className="m-fade-in absolute inset-0 z-10 bg-ink pb-[calc(5.5rem+env(safe-area-inset-bottom))] text-txt">
          <CeremonyScreen
            view={view.ceremony}
            voted={votedLocal || !!view.ceremony.voted}
            onVote={(yes) => {
              setVotedLocal(true);
              void api.again(sessionId, { playerId: me.playerId, token: me.token, yes }).catch(() => setVotedLocal(false));
            }}
          />
        </div>
      )}

      <footer className="relative z-[15] flex items-center gap-3 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <SosButton onFire={sendSos} disabled={!!sosOpen} />
        {isHunter && status === "live" && (
          <button
            className="ui-press m-rise-in min-h-14 flex-1 rounded-2xl border-2 border-white bg-hunter px-4 py-4 text-center text-lg font-black text-white shadow-[var(--shadow-card)]"
            onClick={() => {
              unlockAudio();
              setCatching(true);
            }}
            data-testid="catch"
          >
            {t.catchBtn}
          </button>
        )}
        {isPrey && tag?.code && (
          <button
            className="ui-press m-rise-in min-h-14 flex-1 rounded-2xl border border-white/30 bg-black/30 px-4 py-4 text-center text-lg font-black"
            onClick={() => setShowCode(true)}
            data-testid="show-code"
          >
            {t.showCode}
          </button>
        )}
        {round?.qr && status === "live" && mode === "posts" && (
          <button
            className="ui-press m-rise-in min-h-14 flex-1 rounded-2xl border border-white/30 bg-black/30 px-4 py-4 text-center text-lg font-black"
            onClick={() => {
              unlockAudio();
              setScanning(true);
            }}
            data-testid="scan"
          >
            {t.scan}
          </button>
        )}
        {boot.teacherPhone && (
          <a
            href={`tel:${boot.teacherPhone}`}
            aria-label={t.callTeacherLabel}
            className="ui-press grid size-14 flex-none place-items-center rounded-2xl border border-white/30 bg-black/30 text-2xl"
          >
            <span aria-hidden>📞</span>
          </a>
        )}
      </footer>

      <Toast toast={msgToast} />
      <Toast toast={msgToast ? null : badgeToastView} />

      {/* Never over the SOS screen (safety beats game). */}
      {flash && !sosOpen && !sosAcked && (
        <div
          key={flash.id}
          className={`pointer-events-none absolute inset-0 z-40 flex flex-col items-center justify-center text-center ${
            flash.tone === "gold" ? "bg-gold/85 text-on-accent" : flash.tone === "ok" ? "bg-ok/80 text-on-accent" : "bg-black/60 text-white"
          } animate-[flash_1.6s_ease-out_forwards]`}
          role="status"
          data-testid="flash"
        >
          {flash.tone !== "dim" && (
            <div className="absolute inset-0 grid place-items-center overflow-hidden" aria-hidden>
              <span className="p-ripple col-start-1 row-start-1 block size-[70vmin] rounded-full border-[12px] border-white/70" />
              <span className="p-ripple-2 col-start-1 row-start-1 block size-[70vmin] rounded-full border-[6px] border-white/50" />
            </div>
          )}
          <p className={cx("relative px-4 text-7xl font-black", flash.tone === "dim" ? "m-shake" : "m-pop")}>{flash.text}</p>
          {flash.sub && <p className="relative mt-2 px-4 text-2xl font-black">{flash.sub}</p>}
        </div>
      )}

      {view?.quiz && (status === "live" || status === "paused") && quizDone !== view.quiz.no && (
        <QuizCard
          key={view.quiz.no}
          quiz={view.quiz}
          offsetMs={offsetMs}
          now={now}
          busy={quizBusy}
          onAnswer={async (i) => {
            const no_ = view.quiz!.no;
            setQuizBusy(true);
            try {
              const r = await api.quizAnswer(sessionId, { playerId: me.playerId, token: me.token, choice: i });
              cue(r.right ? "claim" : "lost");
              setFlash({ id: Date.now(), text: r.right ? no.quiz.right : "✗", sub: r.right ? undefined : no.quiz.wrong(r.answer ?? ""), tone: r.right ? "gold" : "dim" });
              queueBadges(r.newBadges);
            } catch (e) {
              const c = e instanceof ApiError ? e.code : "";
              setFlash({ id: Date.now(), text: no.quiz.errors[c] ?? t.qrError, tone: "dim" });
            } finally {
              setQuizDone(no_);
              setQuizBusy(false);
              void tickNow();
            }
          }}
        />
      )}

      {scanning && <QrScanner onCode={onScan} onClose={() => setScanning(false)} busy={scanBusy} />}
      {catching && isHunter && (
        <QrScanner onCode={onCatch} onClose={() => setCatching(false)} busy={scanBusy} title={t.catchTitle} codeLabel={t.preyCode} numeric />
      )}
      {showCode && isPrey && tag?.code && (
        <button
          className="m-scale-in absolute inset-0 z-30 flex flex-col items-center justify-center gap-4 bg-white p-6 text-center text-on-accent"
          onClick={() => setShowCode(false)}
          data-testid="code-sheet"
        >
          <p className="text-2xl font-black">{t.yourCode}</p>
          <QRCode value={catchQr(tag.code)} size={260} />
          <p className="font-mono text-7xl font-black tracking-[0.2em]">{tag.code}</p>
          <p className="text-lg font-bold">{t.codeHint}</p>
          <p className="text-sm font-bold opacity-60">{no.qr.close}</p>
        </button>
      )}

      {(sosOpen || sosAcked) && (
        <div
          className={`absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 p-6 text-center ${sosAcked ? "bg-ok text-on-accent" : "bg-danger"}`}
          role="alertdialog"
          data-testid="sos-overlay"
        >
          <p className="text-6xl">{sosAcked ? "✔" : "🆘"}</p>
          <p className="text-4xl font-black">{sosAcked ? t.sosAcked : t.sosSent}</p>
          {!sosAcked && <p className="text-xl font-bold">{t.sosWaiting}</p>}
          {boot.teacherPhone && (
            <a href={`tel:${boot.teacherPhone}`} className="mt-4 rounded-2xl bg-white px-8 py-5 text-2xl font-black text-on-accent">
              {t.callTeacher}
            </a>
          )}
          {sosAcked && view?.sos && (
            <button className="mt-2 rounded-2xl border-2 border-on-accent px-8 py-3 text-xl font-black" onClick={() => setSosDismissed(view.sos!.id)}>
              OK
            </button>
          )}
        </div>
      )}
    </div>
  );
}

type Tone = "neutral" | "live" | "hunter" | "pause" | "edge" | "warn" | "danger" | "ok";
const TONE_BG: Record<Tone, string> = {
  neutral: "bg-ink text-txt",
  live: "bg-prey text-white",
  hunter: "bg-hunter text-white",
  pause: "bg-ink-3 text-txt",
  edge: "bg-prey text-white ring-[10px] ring-inset ring-warn",
  warn: "bg-warn text-on-accent",
  danger: "bg-danger text-white animate-pulse",
  ok: "bg-ok text-on-accent",
};

function GpsChip({ fix, lost }: { fix: Fix | null; lost: boolean }) {
  if (!fix || lost) return <span className="rounded-full bg-black/30 px-2.5 py-1">{t.gpsSearching}</span>;
  const weak = fix.acc > SAFETY.uncertain_acc_m;
  return (
    <span className={`rounded-full px-2.5 py-1 ${weak ? "bg-danger text-white" : "bg-black/30"}`}>
      {weak ? `${t.gpsWeak} · ` : ""}
      {t.gps(fix.acc)}
    </span>
  );
}

function PlayerMap({
  boot,
  fix,
  posts,
  activeId,
  radar,
  zoneLat,
  zoneLng,
  zoneR,
  zoneNextR,
  targetLat,
  targetLng,
  live,
  teamMap,
  pulseLat = null,
  pulseLng = null,
  activePos = null,
}: {
  boot: PlayerBootstrap;
  fix: Fix | null;
  posts: PostView[];
  activeId: string | null;
  radar: NonNullable<TagView["radar"]>;
  /** Primitives, so the map redraws only when the circle changes (the 1 s clock re-renders). */
  zoneLat: number | null;
  zoneLng: number | null;
  zoneR: number | null;
  zoneNextR: number | null;
  /** Sprint target (0007) and the radar power-up's opponents. */
  targetLat: number | null;
  targetLng: number | null;
  live: { lat: number; lng: number }[];
  /** 0009: flags / hill / teammates / messages as a JSON string (redraw only on change). */
  teamMap: string | null;
  /** Presentation only: the nearest post pulses softly; the post being claimed pulses gold. */
  pulseLat?: number | null;
  pulseLng?: number | null;
  activePos?: { lat: number; lng: number } | null;
}) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const lib = useRef<Awaited<ReturnType<typeof loadMapLibre>> | null>(null);
  const pulse = useRef<Marker | null>(null);
  const shownMe = useRef<[number, number] | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ml = await loadMapLibre();
      if (cancelled || !container.current) return;
      lib.current = ml;
      const m = new ml.Map({
        container: container.current,
        // Greyscale base map on the phones: the game's own colours (boundary, forbidden zone, posts, me) stand out.
        style: kartverketStyle("topograatone"),
        bounds: boundsOf(boot.geo),
        fitBoundsOptions: { padding: 30 },
        attributionControl: { compact: true },
      });
      m.on("load", () => {
        addSessionLayers(m, boot.geo);
        addZoneLayer(m);
        addPostsLayer(m);
        addRadarLayer(m);
        addEventLayer(m);
        addTeamLayer(m);
        addMeLayer(m);
        setReady(true);
      });
      map.current = m;
    })();
    return () => {
      cancelled = true;
      map.current?.remove();
      map.current = null;
      pulse.current = null;
      shownMe.current = null;
    };
  }, [boot.geo]);

  // My dot glides from the last GPS point to the new one (display only; ticks use the raw fix).
  useEffect(() => {
    const m = map.current;
    if (!ready || !m || !fix) return;
    const to: [number, number] = [fix.lng, fix.lat];
    const from = shownMe.current;
    if (!from || prefersReducedMotion() || haversine(from, to) > 150) {
      shownMe.current = to;
      setMe(m, to[0], to[1]);
      return;
    }
    const t0 = performance.now();
    const dur = 900;
    let raf = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      const p: [number, number] = [from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e];
      shownMe.current = p;
      setMe(m, p[0], p[1]);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [ready, fix]);

  // Soft pulse on the post being claimed, else on the nearest post (HTML marker: CSS transform/opacity only).
  const pLat = activePos?.lat ?? pulseLat;
  const pLng = activePos?.lng ?? pulseLng;
  const pActive = !!activePos;
  useEffect(() => {
    const m = map.current;
    const ml = lib.current;
    if (!ready || !m || !ml) return;
    if (pLat === null || pLng === null) {
      pulse.current?.remove();
      pulse.current = null;
      return;
    }
    if (!pulse.current) {
      const el = document.createElement("div");
      el.className = "p-post-pulse";
      el.setAttribute("aria-hidden", "true");
      pulse.current = new ml.Marker({ element: el }).setLngLat([pLng, pLat]).addTo(m);
    } else pulse.current.setLngLat([pLng, pLat]);
    pulse.current.getElement().dataset.active = String(pActive);
  }, [ready, pLat, pLng, pActive]);

  useEffect(() => {
    if (ready && map.current) setPosts(map.current, posts, activeId);
  }, [ready, posts, activeId]);

  useEffect(() => {
    if (ready && map.current) setRadar(map.current, radar);
  }, [ready, radar]);

  useEffect(() => {
    if (!ready || !map.current) return;
    setZone(map.current, zoneLat !== null && zoneLng !== null && zoneR !== null
      ? { c: { lat: zoneLat, lng: zoneLng }, r: zoneR, nextR: zoneNextR } : null);
  }, [ready, zoneLat, zoneLng, zoneR, zoneNextR]);

  // By value: the fox's hunter list is a new array on every tick.
  const liveKey = JSON.stringify(live);
  useEffect(() => {
    if (!ready || !map.current) return;
    const pts = JSON.parse(liveKey) as { lat: number; lng: number }[];
    setEvent(map.current, targetLat !== null && targetLng !== null ? { lat: targetLat, lng: targetLng } : null, EVENTS.sprint_reach_m, pts);
  }, [ready, targetLat, targetLng, liveKey]);

  useEffect(() => {
    if (!ready || !map.current) return;
    if (!teamMap) {
      setTeam(map.current, null);
      return;
    }
    const d = JSON.parse(teamMap) as { palette: { n: number; color: string }[] } & Omit<Parameters<typeof setTeam>[1] & object, "colorOf">;
    setTeam(map.current, { ...d, flagR: TEAMS.flag_r_m, colorOf: (n) => d.palette.find((x) => x.n === n)?.color ?? "#9aa3b2" });
  }, [ready, teamMap]);

  return (
    <div className="absolute inset-0">
      <div ref={container} className="h-full w-full" />
    </div>
  );
}

const NO_LIVE: { lat: number; lng: number }[] = [];

function SosButton({ onFire, disabled }: { onFire: () => void; disabled: boolean }) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  };
  return (
    <button
      type="button"
      disabled={disabled}
      className="relative min-h-14 flex-1 overflow-hidden rounded-2xl border-2 border-white bg-danger px-4 py-4 text-lg font-black text-white select-none disabled:opacity-60"
      onPointerDown={(e) => {
        e.preventDefault();
        setHolding(true);
        timer.current = setTimeout(() => {
          setHolding(false);
          onFire();
        }, SOS_HOLD_MS);
      }}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onContextMenu={(e) => e.preventDefault()}
      data-testid="sos"
    >
      <span
        className="absolute inset-y-0 left-0 bg-white/35"
        style={{ width: holding ? "100%" : "0%", transition: holding ? `width ${SOS_HOLD_MS}ms linear` : "none" }}
        aria-hidden
      />
      <span className="relative">🆘 {holding ? t.sosHolding : t.sosHold}</span>
    </button>
  );
}

function ReadyScreen({ name, onReady, error }: { name: string; onReady: () => void; error: string | null }) {
  return (
    <main className="theme-dark mx-auto flex min-h-dvh max-w-md flex-col px-5 pt-[max(2.5rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))]">
      <div className="m-stagger flex flex-1 flex-col justify-center">
        <p className="text-sm font-black uppercase tracking-[0.25em] text-gold-text" style={{ "--i": 0 } as CSSProperties}>
          {no.brand}
        </p>
        <h1 className="mt-2 text-5xl font-black tracking-tight" style={{ "--i": 1 } as CSSProperties}>
          {t.readyTitle(name)}
        </h1>
        <p className="mt-3 text-lg text-txt-dim" style={{ "--i": 2 } as CSSProperties}>
          {t.readyBody}
        </p>
        <div className="mt-8 rounded-[var(--radius-card)] bg-ink-2 p-5 shadow-[var(--shadow-card)]" style={{ "--i": 3 } as CSSProperties}>
          <p className="text-sm font-extrabold uppercase tracking-wide text-gold-text">{t.rulesTitle}</p>
          <ul className="mt-3 space-y-3">
            {t.rules.map((r, i) => (
              <li key={r} className="flex gap-3 text-lg font-semibold leading-snug">
                <span className="grid size-7 flex-none place-items-center rounded-full bg-gold/20 text-sm font-black text-gold-text">{i + 1}</span>
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </div>
        {error === "unsupported" && (
          <p className="mt-4 rounded-[var(--radius-ctl)] bg-danger/15 px-4 py-3 font-bold text-danger-text" style={{ "--i": 4 } as CSSProperties}>
            {no.map.noGps}
          </p>
        )}
      </div>
      <Button size="xl" className="m-rise-in mt-8 w-full" onClick={onReady} data-testid="ready">
        {t.ready}
      </Button>
    </main>
  );
}

function DeniedHelp({ onRetry }: { onRetry: () => void }) {
  return (
    <main className="theme-dark mx-auto flex min-h-dvh max-w-md flex-col px-5 pt-[max(2.5rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))]">
      <div className="m-stagger flex flex-1 flex-col justify-center">
        <h1 className="text-4xl font-black tracking-tight" style={{ "--i": 0 } as CSSProperties}>
          {t.denied.title}
        </h1>
        <div className="mt-7 rounded-[var(--radius-card)] bg-ink-2 p-5 shadow-[var(--shadow-card)]" style={{ "--i": 1 } as CSSProperties}>
          <h2 className="font-extrabold text-gold-text">iPhone</h2>
          <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-txt-dim">
            {t.denied.ios.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </div>
        <div className="mt-3 rounded-[var(--radius-card)] bg-ink-2 p-5 shadow-[var(--shadow-card)]" style={{ "--i": 2 } as CSSProperties}>
          <h2 className="font-extrabold text-gold-text">Android</h2>
          <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-txt-dim">
            {t.denied.android.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </div>
      </div>
      <Button size="xl" className="m-rise-in mt-8 w-full" onClick={onRetry}>
        {t.denied.retry}
      </Button>
    </main>
  );
}

function Fullscreen({ tone, title, body, link }: { tone: Tone; title: string; body?: string; link?: boolean }) {
  return (
    <main className={cx("theme-dark flex min-h-dvh flex-col items-center justify-center px-6 text-center", TONE_BG[tone])}>
      <div className="m-stagger flex w-full max-w-md flex-col items-center">
        <p className="text-sm font-black uppercase tracking-[0.25em] text-gold-text" style={{ "--i": 0 } as CSSProperties}>
          {no.brand}
        </p>
        <h1 className="mt-3 text-4xl font-black leading-tight tracking-tight" style={{ "--i": 1 } as CSSProperties}>
          {title}
        </h1>
        {body && (
          <p className="mt-3 text-lg text-txt-dim" style={{ "--i": 2 } as CSSProperties}>
            {body}
          </p>
        )}
        {!link && (
          <div className="mt-8 flex gap-2" style={{ "--i": 2 } as CSSProperties} aria-hidden>
            {[0, 1, 2].map((i) => (
              <span key={i} className="size-3 animate-pulse rounded-full bg-gold" style={{ animationDelay: `${i * 160}ms` }} />
            ))}
          </div>
        )}
        {link && (
          <Link href="/j" className={buttonClass("primary", "lg", "mt-8 w-full")} style={{ "--i": 3 } as CSSProperties}>
            {t.toJoin}
          </Link>
        )}
      </div>
    </main>
  );
}

/** Simulator pad (PLAN §11.1, dev or SIM only): arrows/WASD move 5 m, accuracy, signal. */
function SimPad({ sim }: { sim: SimControls }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const step = e.shiftKey ? 20 : 5;
      const k = e.key.toLowerCase();
      if (k === "w" || k === "arrowup") sim.move(0, step);
      else if (k === "s" || k === "arrowdown") sim.move(0, -step);
      else if (k === "a" || k === "arrowleft") sim.move(-step, 0);
      else if (k === "d" || k === "arrowright") sim.move(step, 0);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sim]);
  const b = "grid size-10 place-items-center rounded-lg bg-ink-3 text-lg font-black";
  return (
    <div className="absolute top-2 left-2 z-10 rounded-xl border border-line bg-ink-2/95 p-2 text-xs text-txt" data-testid="simpad">
      <p className="font-bold text-gold">{t.sim.title}</p>
      <div className="mt-1 grid grid-cols-3 gap-1">
        <span />
        <button className={b} onClick={() => sim.move(0, 10)} aria-label="Nord">↑</button>
        <span />
        <button className={b} onClick={() => sim.move(-10, 0)} aria-label="Vest">←</button>
        <button className={b} onClick={() => sim.move(0, -10)} aria-label="Sør">↓</button>
        <button className={b} onClick={() => sim.move(10, 0)} aria-label="Øst">→</button>
      </div>
      <label className="mt-2 block">
        {t.sim.acc(sim.acc)}
        <input type="range" min={3} max={80} value={sim.acc} onChange={(e) => sim.setAcc(Number(e.target.value))} className="block w-28 accent-gold" />
      </label>
      <label className="mt-1 flex items-center gap-2">
        <input type="checkbox" checked={sim.signal} onChange={(e) => sim.setSignal(e.target.checked)} />
        {t.sim.signal}
      </label>
    </div>
  );
}

function nearestPost(fix: Fix | null, posts: PostView[]): { m: number; deg: number; lat: number; lng: number } | null {
  if (!fix || !posts.length) return null;
  let best: { m: number; deg: number; lat: number; lng: number } | null = null;
  for (const p of posts) {
    const m = haversine([fix.lng, fix.lat], [p.pos.lng, p.pos.lat]);
    if (!best || m < best.m) best = { m, deg: bearing([fix.lng, fix.lat], [p.pos.lng, p.pos.lat]), lat: p.pos.lat, lng: p.pos.lng };
  }
  return best;
}

/** «Nærmeste post»: an arrow that turns smoothly towards the post (shortest way round) + the distance in big numbers. */
function Compass({ m, deg, label }: { m: number; deg: number; label: string }) {
  const rot = useTurn(deg);
  return (
    <div className="m-rise-in mt-3 flex items-center gap-4" role="img" aria-label={label} data-testid="compass">
      <span className="grid size-[4.5rem] flex-none place-items-center rounded-full bg-black/25 ring-2 ring-white/40">
        <svg className="p-compass size-11 drop-shadow" style={{ transform: `rotate(${rot}deg)` }} viewBox="0 0 24 24" aria-hidden>
          <path d="M12 1.5 20 21l-8-4.6L4 21z" fill="currentColor" />
        </svg>
      </span>
      <span>
        <span className="block text-xs font-black uppercase tracking-wide opacity-80">{t.nearestShort}</span>
        <span className="block text-5xl font-black leading-none tabular-nums">{t.meters(m)}</span>
      </span>
    </div>
  );
}

/** Breather / end card: this round's effort (PLAN §13 phase 2 «rundeoppsummering»). */
function SummaryCard({ summary, next }: { summary: RoundSummary; next: PlanRound | null }) {
  const cell = "rounded-xl bg-ink-3 p-3";
  return (
    <div
      className="m-rise-in absolute inset-x-3 bottom-3 z-10 rounded-[var(--radius-card)] border border-line bg-ink-2/95 p-4 text-txt shadow-[var(--shadow-float)] backdrop-blur"
      data-testid="summary"
    >
      <p className="text-sm font-extrabold text-gold-text">{t.summary(summary.round + 1)}</p>
      <dl className="m-stagger mt-2 grid grid-cols-2 gap-2">
        <div className={cell} style={{ "--i": 1 } as CSSProperties}>
          <dt className="text-xs font-bold uppercase text-txt-dim">{t.sumPoints}</dt>
          <dd className="text-3xl font-black">{summary.points}</dd>
        </div>
        <div className={cell} style={{ "--i": 2 } as CSSProperties}>
          <dt className="text-xs font-bold uppercase text-txt-dim">{t.sumPosts}</dt>
          <dd className="text-3xl font-black">{summary.posts}</dd>
        </div>
        <div className={cell} style={{ "--i": 3 } as CSSProperties}>
          <dt className="text-xs font-bold uppercase text-txt-dim">{t.sumDistance}</dt>
          <dd className="text-2xl font-black">{t.meters(summary.distance_m)}</dd>
        </div>
        <div className={cell} style={{ "--i": 4 } as CSSProperties}>
          <dt className="text-xs font-bold uppercase text-txt-dim">{t.sumActive}</dt>
          <dd className="text-2xl font-black">{t.minutes(summary.active_s)}</dd>
        </div>
      </dl>
      {summary.move_pts > 0 && <p className="mt-2 text-sm font-bold">{t.sumMove(summary.move_pts)}</p>}
      {summary.badges.length > 0 && (
        <p className="mt-1 text-sm font-bold">{summary.badges.map((b) => t.badges[b] ?? b).join(" · ")}</p>
      )}
      {next && <p className="mt-3 font-extrabold">{t.next(roundTitle(next), Math.round(next.duration_s / 60))}</p>}
    </div>
  );
}
