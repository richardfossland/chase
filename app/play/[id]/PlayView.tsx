"use client";

import "maplibre-gl/dist/maplibre-gl.css";

import type { Map as MlMap } from "maplibre-gl";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, api, type PlayerBootstrap, type TickView } from "@/lib/client/api";
import { identity, type StoredPlayer } from "@/lib/client/identity";
import { useDeviceGps, useSimGps, useWakeLock, vibrate, type Fix, type GpsState, type SimControls } from "@/lib/client/gps";
import { playBuzzer, playDing, unlockAudio } from "@/lib/client/sound";
import { useChannel } from "@/lib/client/useChannel";
import { no } from "@/lib/locale/no";
import { addMeLayer, addSessionLayers, boundsOf, setMe } from "@/lib/map/layers";
import { loadMapLibre } from "@/lib/map/maplibre";
import { kartverketStyle } from "@/lib/map/style";
import { channels } from "@/lib/realtime";
import { SAFETY } from "@/lib/rules/safety";

const t = no.play;
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

  if (me === undefined) return null;
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
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  const [sosLocal, setSosLocal] = useState(false);
  const [sosDismissed, setSosDismissed] = useState<string | null>(null);

  const fixRef = useRef<Fix | null>(null);
  const inflight = useRef(false);
  const seenMsg = useRef<Set<number>>(new Set());
  const danger = useRef(false);

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
      });
      setView(v);
      if (v.status === "ended") setEnded(true);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "";
      if (code === "ended") setEnded(true);
      else if (code === "kicked") setKicked(true);
      // network/timeout/stale: the next tick tries again
    } finally {
      inflight.current = false;
    }
  }, [me.playerId, me.token, sessionId]);

  const status = view?.status ?? boot.status;
  const fast = status === "live" || status === "gathering" || status === "countdown";

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

  // Banner: one main message, most urgent first (safety beats game).
  let tone: Tone = "neutral";
  let title: string = t.lobby;
  let body: string | undefined = t.lobbyHint;
  if (status === "live") {
    tone = "live";
    title = t.live;
    body = undefined;
  }
  if (status === "paused") {
    tone = "pause";
    title = t.paused;
    body = t.pausedBody;
  }
  if (status === "gathering" && view?.gather) {
    tone = view.gather.checked_in ? "ok" : "warn";
    title = view.gather.checked_in ? t.checkedIn : t.gather;
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

  return (
    <div className={`relative flex h-dvh flex-col ${TONE_BG[tone]} transition-colors`}>
      <header className="px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3">
        <div className="flex items-center justify-between text-sm font-bold">
          <span>{me.nickname}</span>
          <GpsChip fix={gps.fix} lost={gpsLost} />
        </div>
        <h1 className="mt-3 text-5xl font-black leading-none tracking-tight" data-testid="play-title">
          {title}
        </h1>
        {body && <p className="mt-2 text-lg font-bold opacity-90">{body}</p>}
        {gpsLost && <p className="mt-2 rounded-xl bg-black/30 px-3 py-2 font-bold">{t.gpsLost}</p>}
        {view && (
          <dl className="mt-3 flex gap-6">
            <div>
              <dt className="text-xs font-bold uppercase opacity-70">{t.distance}</dt>
              <dd className="text-2xl font-black">{t.meters(view.stats.distance_m)}</dd>
            </div>
            <div>
              <dt className="text-xs font-bold uppercase opacity-70">{t.active}</dt>
              <dd className="text-2xl font-black">{t.minutes(view.stats.active_s)}</dd>
            </div>
          </dl>
        )}
      </header>

      <div className="relative min-h-0 flex-1">
        <PlayerMap boot={boot} fix={gps.fix} />
        {sim && <SimPad sim={sim} />}
      </div>

      <footer className="flex items-center gap-3 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <SosButton onFire={sendSos} disabled={!!sosOpen} />
        {boot.teacherPhone && (
          <a
            href={`tel:${boot.teacherPhone}`}
            className="flex-1 rounded-2xl border border-white/30 bg-black/30 px-4 py-4 text-center text-lg font-black"
          >
            {t.callTeacher}
          </a>
        )}
      </footer>

      {toast && (
        <div className="absolute inset-x-3 top-[max(0.75rem,env(safe-area-inset-top))] rounded-2xl border border-gold bg-ink-2 p-4 shadow-2xl" role="status">
          <p className="text-xs font-bold uppercase text-gold">{t.message}</p>
          <p className="mt-1 text-xl font-black">{toast.text}</p>
        </div>
      )}

      {(sosOpen || sosAcked) && (
        <div
          className={`absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 p-6 text-center ${sosAcked ? "bg-ok text-ink" : "bg-danger"}`}
          role="alertdialog"
          data-testid="sos-overlay"
        >
          <p className="text-6xl">{sosAcked ? "✔" : "🆘"}</p>
          <p className="text-4xl font-black">{sosAcked ? t.sosAcked : t.sosSent}</p>
          {!sosAcked && <p className="text-xl font-bold">{t.sosWaiting}</p>}
          {boot.teacherPhone && (
            <a href={`tel:${boot.teacherPhone}`} className="mt-4 rounded-2xl bg-white px-8 py-5 text-2xl font-black text-ink">
              {t.callTeacher}
            </a>
          )}
          {sosAcked && view?.sos && (
            <button className="mt-2 rounded-2xl border-2 border-ink px-8 py-3 text-xl font-black" onClick={() => setSosDismissed(view.sos!.id)}>
              OK
            </button>
          )}
        </div>
      )}
    </div>
  );
}

type Tone = "neutral" | "live" | "pause" | "edge" | "warn" | "danger" | "ok";
const TONE_BG: Record<Tone, string> = {
  neutral: "bg-ink text-txt",
  live: "bg-prey text-white",
  pause: "bg-ink-3 text-txt",
  edge: "bg-prey text-white ring-[10px] ring-inset ring-warn",
  warn: "bg-warn text-ink",
  danger: "bg-danger text-white animate-pulse",
  ok: "bg-ok text-ink",
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

function PlayerMap({ boot, fix }: { boot: PlayerBootstrap; fix: Fix | null }) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const lib = await loadMapLibre();
      if (cancelled || !container.current) return;
      const m = new lib.Map({
        container: container.current,
        style: kartverketStyle("topo"),
        bounds: boundsOf(boot.geo),
        fitBoundsOptions: { padding: 30 },
        attributionControl: { compact: true },
      });
      m.on("load", () => {
        addSessionLayers(m, boot.geo);
        addMeLayer(m);
        setReady(true);
      });
      map.current = m;
    })();
    return () => {
      cancelled = true;
      map.current?.remove();
      map.current = null;
    };
  }, [boot.geo]);

  useEffect(() => {
    if (ready && map.current && fix) setMe(map.current, fix.lng, fix.lat);
  }, [ready, fix]);

  return (
    <div className="absolute inset-0">
      <div ref={container} className="h-full w-full" />
    </div>
  );
}

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
      className="relative flex-1 overflow-hidden rounded-2xl border-2 border-white bg-danger px-4 py-4 text-lg font-black text-white select-none disabled:opacity-60"
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
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-5 py-10">
      <h1 className="text-4xl font-black">{t.readyTitle(name)}</h1>
      <p className="mt-3 text-lg text-txt-dim">{t.readyBody}</p>
      <div className="mt-6 rounded-2xl border border-line bg-ink-2 p-4">
        <p className="text-sm font-extrabold text-gold">{t.rulesTitle}</p>
        <ul className="mt-2 space-y-2">
          {t.rules.map((r) => (
            <li key={r} className="font-semibold">
              • {r}
            </li>
          ))}
        </ul>
      </div>
      {error === "unsupported" && <p className="mt-4 font-semibold text-danger">{no.map.noGps}</p>}
      <button
        className="mt-6 w-full rounded-2xl bg-gold px-6 py-5 text-2xl font-black text-ink active:scale-[0.98]"
        onClick={onReady}
        data-testid="ready"
      >
        {t.ready}
      </button>
    </main>
  );
}

function DeniedHelp({ onRetry }: { onRetry: () => void }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-5 py-10">
      <h1 className="text-3xl font-black">{t.denied.title}</h1>
      <h2 className="mt-6 font-extrabold">iPhone</h2>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-txt-dim">
        {t.denied.ios.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      <h2 className="mt-5 font-extrabold">Android</h2>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-txt-dim">
        {t.denied.android.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      <button className="mt-6 w-full rounded-2xl bg-gold px-6 py-4 text-xl font-black text-ink" onClick={onRetry}>
        {t.denied.retry}
      </button>
    </main>
  );
}

function Fullscreen({ tone, title, body, link }: { tone: Tone; title: string; body?: string; link?: boolean }) {
  return (
    <main className={`flex min-h-dvh flex-col items-center justify-center gap-3 px-6 text-center ${TONE_BG[tone]}`}>
      <h1 className="text-3xl font-black">{title}</h1>
      {body && <p className="text-lg text-txt-dim">{body}</p>}
      {link && (
        <Link href="/j" className="mt-4 rounded-xl bg-gold px-6 py-3 font-extrabold text-ink">
          {t.toJoin}
        </Link>
      )}
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
