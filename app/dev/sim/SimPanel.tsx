"use client";

import "maplibre-gl/dist/maplibre-gl.css";

import type { GeoJSONSource, Map as MlMap } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";

import { identity } from "@/lib/client/identity";
import { addSessionLayers, boundsOf } from "@/lib/map/layers";
import { loadMapLibre } from "@/lib/map/maplibre";
import { kartverketStyle } from "@/lib/map/style";
import type { SessionGeo } from "@/lib/client/api";
import { BEHAVIOURS, defaultMix, httpTransport, parseMix, startSwarm, summarize, type SimPlayer, type SimStats } from "@/lib/sim";

const KIND_COLOUR: Record<string, string> = {
  runner: "#3d9bff",
  hider: "#a78bfa",
  wanderer: "#ffb020",
  forbidden: "#ff5a4e",
  dropout: "#9ca3af",
  sos: "#ff3b30",
  cheater: "#f472b6",
  jitter: "#22d3ee",
};

type Swarm = ReturnType<typeof startSwarm>;

/**
 * Browser bot swarm (PLAN §11.2): N real players through the API with seeded
 * behaviours, their own map and a timeline. Open the teacher panel in another
 * tab to watch the alarms arrive; with the host token here, alarm latency is
 * measured too.
 */
export default function SimPanel() {
  const [pin, setPin] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [hostToken, setHostToken] = useState("");
  const [n, setN] = useState(12);
  const [mix, setMix] = useState("");
  const [seed, setSeed] = useState(42);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [summary, setSummary] = useState<ReturnType<typeof summarize> | null>(null);
  const [geo, setGeo] = useState<SessionGeo | null>(null);
  const swarm = useRef<Swarm | null>(null);
  const map = useRef<MlMap | null>(null);
  const mapEl = useRef<HTMLDivElement>(null);
  const [mapReady, setMapReady] = useState(false);

  const say = (l: string) => setLog((xs) => [`${new Date().toLocaleTimeString("nb-NO")}  ${l}`, ...xs].slice(0, 80));

  async function createSession() {
    const t = httpTransport("");
    const r = await t.post("/api/sessions", {
      boundary: square(59.9101, 10.7499, 150, 120),
      assembly: { type: "Point", coordinates: [10.7512, 59.91064] },
      forbidden: { type: "MultiPolygon", coordinates: [square(59.91115, 10.7518, 25, 20).coordinates] },
      teacherPhone: "91234567",
      sim: true,
    });
    if (r.status !== 200) return say(`Kunne ikke lage økt: ${JSON.stringify(r.data)}`);
    const sid = String(r.data.sessionId);
    identity.saveHostToken(sid, String(r.data.hostToken));
    setPin(String(r.data.pin));
    setSessionId(sid);
    setHostToken(String(r.data.hostToken));
    say(`Sim-økt laget. PIN ${String(r.data.pin)}. Lærerpanelet er klart i ny fane.`);
  }

  function connectHost() {
    if (sessionId && hostToken) {
      identity.saveHostToken(sessionId, hostToken);
      say("Lærertoken lagret – alarmtid måles, og lærerpanelet kan åpnes.");
    }
  }

  async function hostAction(action: string) {
    const r = await httpTransport("").post(`/api/s/${sessionId}/host`, { hostToken, action });
    say(r.status === 200 ? `Lærer: ${action}` : `Lærer: ${action} feilet (${r.status})`);
  }

  async function start() {
    if (running) return;
    let kinds;
    try {
      kinds = mix.trim() ? parseMix(mix) : defaultMix(n);
    } catch (e) {
      return say(String(e));
    }
    setRunning(true);
    const s = startSwarm({
      transport: httpTransport(""),
      pin,
      kinds: kinds.slice(0, 60),
      seed,
      hostToken: hostToken || undefined,
      sosAfterS: 45,
      dropoutAfterS: 30,
      dropoutForS: 90,
      onLog: say,
      onUpdate: (players, stats) => {
        setSummary(summarize(stats));
        drawBots(players, stats);
      },
    });
    swarm.current = s;
    try {
      const { sessionId: sid, geo: g } = await s.ready;
      setSessionId(sid);
      setGeo(g as unknown as SessionGeo);
    } catch (e) {
      say(String(e));
      s.stop();
      setRunning(false);
    }
  }

  function stop() {
    swarm.current?.stop();
    swarm.current = null;
    setRunning(false);
    say("Svermen er stoppet.");
  }

  useEffect(() => () => swarm.current?.stop(), []);

  // Map: session geometry + bot dots.
  useEffect(() => {
    if (!geo || !mapEl.current) return;
    let cancelled = false;
    (async () => {
      const ml = await loadMapLibre();
      if (cancelled || !mapEl.current) return;
      const m = new ml.Map({ container: mapEl.current, style: kartverketStyle("topograatone"), bounds: boundsOf(geo), fitBoundsOptions: { padding: 30 } });
      m.on("load", () => {
        addSessionLayers(m, geo);
        m.addSource("bots", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        m.addLayer({
          id: "bots",
          type: "circle",
          source: "bots",
          paint: {
            "circle-radius": 6,
            "circle-color": ["get", "colour"],
            "circle-stroke-color": ["get", "stroke"],
            "circle-stroke-width": 2,
          },
        });
        setMapReady(true);
      });
      map.current = m;
    })();
    return () => {
      cancelled = true;
      map.current?.remove();
      map.current = null;
      setMapReady(false);
    };
  }, [geo]);

  function drawBots(players: SimPlayer[], _stats: SimStats) {
    void _stats;
    const m = map.current;
    if (!m) return;
    const features = players
      .filter((p) => p.bot)
      .map((p) => {
        const pos = p.bot.truePos();
        const safety = (p.view?.safety ?? {}) as { geofence?: number; forbidden?: boolean };
        const danger = safety.forbidden || (safety.geofence ?? 0) >= 2;
        return {
          type: "Feature" as const,
          properties: {
            colour: p.lastFix ? KIND_COLOUR[p.kind] : "#4b5563",
            stroke: danger ? "#ff3b30" : "#ffffff",
          },
          geometry: { type: "Point" as const, coordinates: [pos.lng, pos.lat] },
        };
      });
    m.getSource<GeoJSONSource>("bots")?.setData({ type: "FeatureCollection", features });
  }

  const input = "rounded-lg border border-line bg-ink px-2 py-1.5 font-mono text-sm outline-none focus:border-gold";
  const btn = "rounded-lg bg-ink-3 px-3 py-1.5 text-sm font-bold hover:bg-line disabled:opacity-40";

  return (
    <main className="grid min-h-dvh gap-3 p-3 lg:grid-cols-[24rem_1fr]">
      <section className="space-y-3 text-sm">
        <h1 className="text-xl font-black">
          <span className="text-gold">Chase</span> · GPS-simulator
        </h1>

        <fieldset className="space-y-2 rounded-xl border border-line p-3">
          <legend className="px-1 font-bold">Økt</legend>
          <div className="flex gap-2">
            <input className={`${input} w-28`} placeholder="PIN" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
            <button className={btn} onClick={createSession} disabled={running}>
              Lag sim-økt
            </button>
          </div>
          <input className={`${input} w-full`} placeholder="Økt-ID (for lærertoken)" value={sessionId} onChange={(e) => setSessionId(e.target.value)} />
          <div className="flex gap-2">
            <input className={`${input} min-w-0 flex-1`} placeholder="Lærertoken (valgfritt)" value={hostToken} onChange={(e) => setHostToken(e.target.value)} />
            <button className={btn} onClick={connectHost} disabled={!sessionId || !hostToken}>
              Lagre
            </button>
          </div>
          {sessionId && hostToken && (
            <div className="flex flex-wrap gap-2">
              <a className={btn} href={`/host/${sessionId}`} target="_blank" rel="noreferrer">
                Åpne lærerpanel ↗
              </a>
              <button className={btn} onClick={() => hostAction("start")}>Start</button>
              <button className={btn} onClick={() => hostAction("pause")}>Pause</button>
              <button className={btn} onClick={() => hostAction("resume")}>Fortsett</button>
              <button className={btn} onClick={() => hostAction("gather")}>Samling</button>
            </div>
          )}
        </fieldset>

        <fieldset className="space-y-2 rounded-xl border border-line p-3">
          <legend className="px-1 font-bold">Sverm</legend>
          <label className="block">
            Antall boter: <b>{n}</b>
            <input type="range" min={1} max={60} value={n} onChange={(e) => setN(Number(e.target.value))} className="block w-full accent-gold" />
          </label>
          <input className={`${input} w-full`} placeholder="Blanding, f.eks. runner:20,sos:1 (tom = standard)" value={mix} onChange={(e) => setMix(e.target.value)} />
          <p className="text-xs text-txt-dim">{BEHAVIOURS.join(" · ")}</p>
          <label className="flex items-center gap-2">
            Seed
            <input className={`${input} w-24`} type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value))} />
          </label>
          <div className="flex gap-2">
            <button className="rounded-lg bg-gold px-4 py-2 font-black text-on-accent disabled:opacity-40" onClick={start} disabled={running || !/^\d{6}$/.test(pin)}>
              ▶ Start sverm
            </button>
            <button className={btn} onClick={stop} disabled={!running}>
              ■ Stopp
            </button>
          </div>
        </fieldset>

        {summary && (
          <div className="rounded-xl border border-line p-3 font-mono text-xs" data-testid="sim-summary">
            <p>tid {summary.seconds}s · ticks {summary.ticks}</p>
            <p>
              tick p50 {summary.tickMs.p50} ms · p95 {summary.tickMs.p95} ms · maks {summary.tickMs.max} ms
            </p>
            <p>
              alarmer sett {summary.alarms.seen}/{summary.alarms.expected}
              {summary.alarms.maxDelayS !== null ? ` · verst ${summary.alarms.maxDelayS.toFixed(1)} s` : ""}
            </p>
            {summary.alarms.pending.length > 0 && <p className="text-warn">venter: {summary.alarms.pending.join(", ")}</p>}
            {Object.keys(summary.errors).length > 0 && <p className="text-danger">feil {JSON.stringify(summary.errors)}</p>}
          </div>
        )}

        <ol className="max-h-64 overflow-y-auto rounded-xl border border-line p-2 font-mono text-xs text-txt-dim">
          {log.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ol>
      </section>

      <section className="relative min-h-[60dvh] overflow-hidden rounded-xl border border-line">
        <div className="absolute inset-0">
          <div ref={mapEl} className="h-full w-full" />
        </div>
        {!mapReady && <p className="absolute inset-0 grid place-items-center text-txt-dim">Kartet vises når svermen er i gang.</p>}
        <ul className="absolute right-2 bottom-8 rounded-lg bg-ink-2/90 p-2 text-xs">
          {Object.entries(KIND_COLOUR).map(([k, c]) => (
            <li key={k} className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-full" style={{ background: c }} />
              {k}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

function square(lat: number, lng: number, wM: number, hM: number) {
  const dLat = hM / 111_320;
  const dLng = wM / (111_320 * Math.cos((lat * Math.PI) / 180));
  return {
    type: "Polygon" as const,
    coordinates: [[[lng, lat], [lng + dLng, lat], [lng + dLng, lat + dLat], [lng, lat + dLat], [lng, lat]]],
  };
}
