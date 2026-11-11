"use client";

import "maplibre-gl/dist/maplibre-gl.css";

import type { GeoJSONSource, Map as MlMap, Marker } from "maplibre-gl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiError, api } from "@/lib/client/api";
import { identity } from "@/lib/client/identity";
import {
  circleRing,
  closeRing,
  pointInRing,
  ringArea,
  ringCenter,
  ringSelfIntersects,
  signedDistanceToRing,
  type LngLat,
} from "@/lib/geo";
import { no } from "@/lib/locale/no";
import { DEFAULT_PLAN, GAME, TEMPLATES, normPlan, planTotalS, type Plan, type RoundMode, type TemplateId } from "@/lib/rules/game";
import { loadMapLibre } from "@/lib/map/maplibre";
import { DEFAULT_CENTER, kartverketStyle } from "@/lib/map/style";

const t = no.wizard;

type Step = "intro" | "area" | "forbidden" | "assembly" | "playlist" | "safety";
type AreaMode = "circle" | "draw";
type DrawTarget = "area" | "forbidden" | null;

const STEPS: Step[] = ["area", "forbidden", "assembly", "playlist", "safety"];
const WARN_MAX_M2 = 500_000;
const WARN_MIN_M2 = 3_000;
const HARD_MIN_M2 = 500;
const HARD_MAX_M2 = 5_000_000;
const ASSEMBLY_MAX_M = 200;

type Feature = {
  type: "Feature";
  properties: Record<string, never>;
  geometry: { type: "Polygon"; coordinates: number[][][] } | { type: "LineString"; coordinates: number[][] };
};
type FeatureCollection = { type: "FeatureCollection"; features: Feature[] };

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

function polygonFeature(ring: LngLat[]): Feature {
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [closeRing(ring).map((p) => [...p])] },
  };
}

/** Default assembly point: inside the area and ≥ 30 m from every forbidden zone if possible. */
function defaultAssembly(area: LngLat[], forbidden: LngLat[][]): LngLat {
  const c = ringCenter(area);
  const candidates: LngLat[] = [c];
  for (const f of [0.5, 0.75]) {
    for (const v of area) candidates.push([c[0] + (v[0] - c[0]) * f, c[1] + (v[1] - c[1]) * f]);
  }
  const clear = (p: LngLat) => forbidden.every((z) => signedDistanceToRing(p, z) >= 30);
  return candidates.find((p) => pointInRing(p, area) && clear(p)) ?? candidates.find((p) => pointInRing(p, area)) ?? area[0];
}

function errorText(code: string): string {
  return (t.errors as Record<string, string>)[code] ?? t.errors.default;
}

/**
 * Teacher onboarding (PLAN §2.1, phase 1 scope): area (circle around me or a
 * drawn polygon), forbidden zones, assembly point, safety → create → lobby.
 * The drawing tool is our own: tap to add a corner, drag a corner marker to
 * move it (native MapLibre draggable markers = good touch targets).
 */
export default function Wizard() {
  const router = useRouter();
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const ml = useRef<Awaited<ReturnType<typeof loadMapLibre>> | null>(null);
  const vertexMarkers = useRef<Marker[]>([]);
  const assemblyMarker = useRef<Marker | null>(null);

  const [ready, setReady] = useState(false);
  const [step, setStep] = useState<Step>("area");
  const [teacherKey, setTeacherKey] = useState<string | null>(null);

  const [me, setMe] = useState<LngLat | null>(null);
  const [gpsState, setGpsState] = useState<"locating" | "ok" | "error">("locating");

  const [areaMode, setAreaMode] = useState<AreaMode>("circle");
  const [circleCentre, setCircleCentre] = useState<LngLat | null>(null);
  const [radius, setRadius] = useState(120);
  const [drawnArea, setDrawnArea] = useState<LngLat[] | null>(null);

  const [drawTarget, setDrawTarget] = useState<DrawTarget>(null);
  const [draft, setDraft] = useState<LngLat[]>([]);
  const [draftError, setDraftError] = useState<string | null>(null);

  const [forbidden, setForbidden] = useState<LngLat[][]>([]);
  const [assembly, setAssembly] = useState<LngLat | null>(null);

  const [phone, setPhone] = useState("");
  const [plan, setPlan] = useState<Plan>(DEFAULT_PLAN);
  const [checks, setChecks] = useState<boolean[]>(t.safety.checks.map(() => false));
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // First visit: introduce + show the lærernøkkel once.
  useEffect(() => {
    const { key } = identity.ensureTeacherKey();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reading localStorage after mount
    setTeacherKey(key);
    if (!identity.hasSeenIntro()) setStep("intro");
  }, []);

  // ── derived area ──
  const areaRing: LngLat[] | null = useMemo(() => {
    if (areaMode === "circle") return circleCentre ? circleRing(circleCentre, radius, 48).slice(0, -1) : null;
    return drawnArea;
  }, [areaMode, circleCentre, radius, drawnArea]);
  const areaM2 = areaRing ? ringArea(areaRing) : 0;
  const areaWarning =
    areaRing === null
      ? null
      : areaM2 < HARD_MIN_M2 || areaM2 > HARD_MAX_M2
        ? t.area.hardLimit
        : areaM2 > WARN_MAX_M2
          ? t.area.tooBig
          : areaM2 < WARN_MIN_M2
            ? t.area.tooSmall
            : null;
  const areaBlocked = !areaRing || areaM2 < HARD_MIN_M2 || areaM2 > HARD_MAX_M2 || drawTarget !== null;
  const assemblyFar = !!(assembly && areaRing && signedDistanceToRing(assembly, areaRing) > ASSEMBLY_MAX_M);
  const assemblyForbidden = !!(assembly && forbidden.some((z) => pointInRing(assembly, z)));

  // ── map setup ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const lib = await loadMapLibre();
      if (cancelled || !container.current) return;
      ml.current = lib;
      const m = new lib.Map({
        container: container.current,
        style: kartverketStyle("topo"),
        center: DEFAULT_CENTER,
        zoom: 16,
        attributionControl: { compact: true },
      });
      m.addControl(new lib.NavigationControl({ showCompass: false }), "top-right");
      const geo = new lib.GeolocateControl({
        positionOptions: { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
        trackUserLocation: true,
        showAccuracyCircle: true,
      });
      m.addControl(geo, "top-right");
      geo.on("geolocate", (e) => {
        const p: LngLat = [e.coords.longitude, e.coords.latitude];
        setGpsState("ok");
        setMe(p);
        setCircleCentre((prev) => prev ?? p);
      });
      geo.on("error", () => setGpsState("error"));
      m.on("load", () => {
        m.addSource("area", { type: "geojson", data: EMPTY });
        m.addLayer({ id: "area-fill", type: "fill", source: "area", paint: { "fill-color": "#ebb84b", "fill-opacity": 0.14 } });
        m.addLayer({ id: "area-line", type: "line", source: "area", paint: { "line-color": "#ebb84b", "line-width": 3 } });
        m.addSource("forbidden", { type: "geojson", data: EMPTY });
        m.addLayer({ id: "forbidden-fill", type: "fill", source: "forbidden", paint: { "fill-color": "#ff3b30", "fill-opacity": 0.3 } });
        m.addLayer({ id: "forbidden-line", type: "line", source: "forbidden", paint: { "line-color": "#ff3b30", "line-width": 2 } });
        m.addSource("draft", { type: "geojson", data: EMPTY });
        m.addLayer({
          id: "draft-line",
          type: "line",
          source: "draft",
          paint: { "line-color": "#ffffff", "line-width": 2, "line-dasharray": [2, 1.5] },
        });
        setReady(true);
        geo.trigger();
      });
      map.current = m;
    })();
    return () => {
      cancelled = true;
      vertexMarkers.current.forEach((mk) => mk.remove());
      assemblyMarker.current?.remove();
      map.current?.remove();
      map.current = null;
    };
  }, []);

  // GPS never answered: fall back to the map centre after a while.
  useEffect(() => {
    if (gpsState !== "error" || circleCentre || !map.current) return;
    const c = map.current.getCenter();
    setCircleCentre([c.lng, c.lat]);
  }, [gpsState, circleCentre]);

  // ── sync sources ──
  useEffect(() => {
    if (!ready || !map.current) return;
    const src = map.current.getSource<GeoJSONSource>("area");
    src?.setData(areaRing && drawTarget !== "area" ? polygonFeature(areaRing) : EMPTY);
  }, [ready, areaRing, drawTarget]);

  useEffect(() => {
    if (!ready || !map.current) return;
    map.current
      .getSource<GeoJSONSource>("forbidden")
      ?.setData({ type: "FeatureCollection", features: forbidden.map(polygonFeature) });
  }, [ready, forbidden]);

  useEffect(() => {
    if (!ready || !map.current) return;
    const data: Feature | FeatureCollection =
      draft.length >= 2
        ? {
            type: "Feature",
            properties: {},
            geometry: { type: "LineString", coordinates: [...draft, ...(draft.length >= 3 ? [draft[0]] : [])].map((p) => [...p]) },
          }
        : EMPTY;
    map.current.getSource<GeoJSONSource>("draft")?.setData(data);
  }, [ready, draft]);

  // Draggable corner markers for the draft polygon.
  useEffect(() => {
    const m = map.current;
    const lib = ml.current;
    vertexMarkers.current.forEach((mk) => mk.remove());
    vertexMarkers.current = [];
    if (!ready || !m || !lib || !drawTarget) return;
    draft.forEach((p, i) => {
      const el = document.createElement("div");
      el.className = `size-7 rounded-full border-[3px] border-white shadow-lg ${drawTarget === "area" ? "bg-gold" : "bg-danger"}`;
      el.setAttribute("aria-label", `Hjørne ${i + 1}`);
      const mk = new lib.Marker({ element: el, draggable: true }).setLngLat([p[0], p[1]]).addTo(m);
      mk.on("drag", () => {
        const ll = mk.getLngLat();
        setDraft((d) => d.map((q, j) => (j === i ? [ll.lng, ll.lat] : q)));
      });
      vertexMarkers.current.push(mk);
    });
    // Re-create markers only when the corner count changes, not on every drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, drawTarget, draft.length]);

  // Tap adds a corner while drawing.
  useEffect(() => {
    const m = map.current;
    if (!ready || !m || !drawTarget) return;
    const onClick = (e: { lngLat: { lng: number; lat: number } }) => {
      setDraftError(null);
      setDraft((d) => [...d, [e.lngLat.lng, e.lngLat.lat]]);
    };
    m.on("click", onClick);
    m.getCanvas().style.cursor = "crosshair";
    return () => {
      m.off("click", onClick);
      m.getCanvas().style.cursor = "";
    };
  }, [ready, drawTarget]);

  // Assembly marker (draggable) on its step and after.
  useEffect(() => {
    const m = map.current;
    const lib = ml.current;
    if (!ready || !m || !lib) return;
    const show = assembly && (step === "assembly" || step === "safety");
    if (!show) {
      assemblyMarker.current?.remove();
      assemblyMarker.current = null;
      return;
    }
    if (!assemblyMarker.current) {
      const el = document.createElement("div");
      el.className = "grid size-11 place-items-center rounded-full border-[3px] border-white bg-ok text-xl shadow-xl";
      el.textContent = "🧲";
      el.setAttribute("aria-label", "Samlingspunkt");
      const mk = new lib.Marker({ element: el, draggable: step === "assembly" }).setLngLat([assembly[0], assembly[1]]).addTo(m);
      mk.on("dragend", () => {
        const ll = mk.getLngLat();
        setAssembly([ll.lng, ll.lat]);
      });
      assemblyMarker.current = mk;
    } else {
      assemblyMarker.current.setLngLat([assembly[0], assembly[1]]);
      assemblyMarker.current.setDraggable(step === "assembly");
    }
  }, [ready, assembly, step]);

  // Keep the area in view when it changes shape (not while drawing).
  const fitArea = useCallback(() => {
    const m = map.current;
    if (!m || !areaRing || areaRing.length < 3) return;
    const lngs = areaRing.map((p) => p[0]);
    const lats = areaRing.map((p) => p[1]);
    m.fitBounds(
      [
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      ],
      { padding: { top: 80, left: 40, right: 60, bottom: 340 }, maxZoom: 18, duration: 500 },
    );
  }, [areaRing]);

  // ── drawing actions ──
  function startDraw(target: Exclude<DrawTarget, null>) {
    setDraft([]);
    setDraftError(null);
    setDrawTarget(target);
  }
  function cancelDraw() {
    setDraft([]);
    setDraftError(null);
    setDrawTarget(null);
  }
  function finishDraw() {
    if (draft.length < 3) return setDraftError(t.area.needThree);
    if (ringSelfIntersects(draft)) return setDraftError(t.area.crossing);
    if (drawTarget === "area") {
      setDrawnArea(draft);
    } else if (drawTarget === "forbidden") {
      const c = ringCenter(draft);
      if (areaRing && signedDistanceToRing(c, areaRing) > ASSEMBLY_MAX_M) return setDraftError(t.forbidden.outside);
      setForbidden((f) => [...f, draft]);
    }
    cancelDraw();
  }

  // ── step navigation ──
  function goTo(next: Step) {
    if (next === "assembly" && !assembly && areaRing) setAssembly(defaultAssembly(areaRing, forbidden));
    setStep(next);
    if (next !== "intro") setTimeout(fitArea, 0);
  }
  const idx = STEPS.indexOf(step);

  async function create() {
    if (!areaRing || !assembly || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await api.createSession({
        teacherKey: teacherKey ?? undefined,
        boundary: { type: "Polygon", coordinates: [closeRing(areaRing).map((p) => [p[0], p[1]])] },
        assembly: { type: "Point", coordinates: [assembly[0], assembly[1]] },
        forbidden: forbidden.length
          ? { type: "MultiPolygon", coordinates: forbidden.map((r) => [closeRing(r).map((p) => [p[0], p[1]])]) }
          : null,
        teacherPhone: phone.trim() || null,
        plan,
      });
      identity.saveHostToken(res.sessionId, res.hostToken);
      router.replace(`/host/${res.sessionId}`);
    } catch (e) {
      setCreateError(errorText(e instanceof ApiError ? e.code : "default"));
      setCreating(false);
    }
  }

  // ── UI ──
  const sheet = "pointer-events-auto mx-auto max-h-[55dvh] max-w-md overflow-y-auto rounded-2xl border border-line bg-ink-2/95 p-4 shadow-2xl backdrop-blur";
  const primary =
    "rounded-xl bg-gold px-5 py-3 text-lg font-extrabold text-ink transition hover:bg-gold-light active:scale-[0.98] disabled:opacity-40";
  const secondary = "rounded-xl border border-line px-4 py-3 font-bold text-txt transition hover:bg-ink-3 disabled:opacity-40";
  const chip = (on: boolean) =>
    `flex-1 rounded-xl px-3 py-2.5 text-sm font-extrabold transition disabled:opacity-40 ${on ? "bg-gold text-ink" : "border border-line text-txt hover:bg-ink-3"}`;

  return (
    <div className="relative h-dvh w-full">
      <div className="absolute inset-0">
        <div ref={container} className="h-full w-full" />
      </div>

      {/* top: progress */}
      {step !== "intro" && (
        <div className="pointer-events-none absolute inset-x-0 top-0 p-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
          <div className="pointer-events-auto mr-14 flex max-w-md items-center gap-3 rounded-2xl border border-line bg-ink-2/95 px-3 py-2 backdrop-blur">
            <Link href="/" className="text-sm text-txt-dim" aria-label={no.common.home}>
              ✕
            </Link>
            <ol className="flex flex-1 gap-1.5" aria-label={t.title}>
              {STEPS.map((s, i) => (
                <li key={s} className={`h-1.5 flex-1 rounded-full ${i <= idx ? "bg-gold" : "bg-ink-3"}`} />
              ))}
            </ol>
            <span className="text-sm font-bold">{t.steps[idx]}</span>
          </div>
        </div>
      )}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {step === "intro" && (
          <div className={sheet}>
            <h1 className="text-2xl font-black">{t.intro.title}</h1>
            <p className="mt-2 text-txt-dim">{t.intro.body}</p>
            <div className="mt-4 rounded-xl border border-gold/40 bg-ink p-3">
              <p className="text-sm font-extrabold text-gold">{t.intro.keyTitle}</p>
              <p className="mt-1 font-mono text-xl font-bold tracking-wider" data-testid="teacher-key">
                {teacherKey}
              </p>
              <p className="mt-2 text-sm text-txt-dim">{t.intro.keyBody}</p>
            </div>
            <button
              className={`${primary} mt-4 w-full`}
              onClick={() => {
                identity.markIntroSeen();
                goTo("area");
              }}
            >
              {t.intro.start}
            </button>
          </div>
        )}

        {step === "area" && (
          <div className={sheet}>
            <p className="font-extrabold">{t.area.lead}</p>
            {!drawTarget && (
              <div className="mt-3 flex gap-2">
                <button className={chip(areaMode === "circle")} onClick={() => setAreaMode("circle")}>
                  {t.area.circle}
                </button>
                <button
                  className={chip(areaMode === "draw")}
                  onClick={() => {
                    setAreaMode("draw");
                    if (!drawnArea) startDraw("area");
                  }}
                >
                  {t.area.draw}
                </button>
              </div>
            )}

            {areaMode === "circle" && (
              <>
                {gpsState === "locating" && !circleCentre && <p className="mt-3 text-sm text-txt-dim">{t.area.locating}</p>}
                {gpsState === "error" && <p className="mt-3 text-sm font-semibold text-warn">{t.area.noGps}</p>}
                <label className="mt-3 block">
                  <span className="flex justify-between text-sm font-semibold">
                    <span>{t.area.radius(radius)}</span>
                    <span className="text-txt-dim">{no.map.area(areaM2)}</span>
                  </span>
                  <input
                    type="range"
                    min={50}
                    max={400}
                    step={10}
                    value={radius}
                    onChange={(e) => setRadius(Number(e.target.value))}
                    className="mt-2 w-full accent-gold"
                  />
                </label>
                <button
                  className="mt-1 text-sm text-txt-dim underline underline-offset-4"
                  onClick={() => {
                    const c = map.current?.getCenter();
                    if (c) setCircleCentre([c.lng, c.lat]);
                  }}
                >
                  {t.area.useMapCentre}
                </button>
              </>
            )}

            {areaMode === "draw" && (
              <DrawControls
                active={drawTarget === "area"}
                count={draft.length}
                error={draftError}
                onUndo={() => setDraft((d) => d.slice(0, -1))}
                onClear={() => setDraft([])}
                onFinish={finishDraw}
                onCancel={drawnArea ? cancelDraw : undefined}
                summary={drawnArea && drawTarget !== "area" ? no.map.area(areaM2) : null}
                onRedraw={() => startDraw("area")}
              />
            )}

            {areaWarning && !drawTarget && <p className="mt-3 text-sm font-semibold text-warn">{areaWarning}</p>}

            {!drawTarget && (
              <div className="mt-4 flex justify-end">
                <button className={primary} disabled={areaBlocked} onClick={() => goTo("forbidden")}>
                  {t.next}
                </button>
              </div>
            )}
          </div>
        )}

        {step === "forbidden" && (
          <div className={sheet}>
            <p className="font-extrabold">{t.forbidden.lead}</p>
            {drawTarget === "forbidden" ? (
              <DrawControls
                active
                count={draft.length}
                error={draftError}
                onUndo={() => setDraft((d) => d.slice(0, -1))}
                onClear={() => setDraft([])}
                onFinish={finishDraw}
                onCancel={cancelDraw}
                summary={null}
                onRedraw={() => {}}
              />
            ) : (
              <>
                <ul className="mt-3 space-y-2">
                  {forbidden.length === 0 && <li className="text-sm text-txt-dim">{t.forbidden.none}</li>}
                  {forbidden.map((r, i) => (
                    <li key={i} className="flex items-center justify-between rounded-xl bg-ink px-3 py-2">
                      <span className="flex items-center gap-2 font-bold">
                        <span className="size-3 rounded-sm bg-danger" aria-hidden />
                        {t.forbidden.zone(i + 1)}
                        <span className="text-sm font-normal text-txt-dim">{no.map.area(ringArea(r))}</span>
                      </span>
                      <button
                        className="text-sm font-bold text-danger"
                        onClick={() => setForbidden((f) => f.filter((_, j) => j !== i))}
                      >
                        {t.forbidden.remove}
                      </button>
                    </li>
                  ))}
                </ul>
                <button className={`${secondary} mt-3 w-full`} onClick={() => startDraw("forbidden")}>
                  ＋ {t.forbidden.add}
                </button>
                <div className="mt-4 flex justify-between">
                  <button className={secondary} onClick={() => goTo("area")}>
                    {t.back}
                  </button>
                  <button className={primary} onClick={() => goTo("assembly")}>
                    {forbidden.length ? t.next : t.skip}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {step === "assembly" && (
          <div className={sheet}>
            <p className="font-extrabold">{t.assembly.lead}</p>
            <div className="mt-3 flex gap-2">
              <button className={chip(false)} disabled={!me} onClick={() => me && setAssembly(me)}>
                📍 {t.assembly.here}
              </button>
              <button
                className={chip(false)}
                onClick={() => areaRing && setAssembly(defaultAssembly(areaRing, forbidden))}
              >
                {t.assembly.centre}
              </button>
            </div>
            {assemblyFar && <p className="mt-3 text-sm font-semibold text-danger">{t.assembly.far}</p>}
            {assemblyForbidden && <p className="mt-3 text-sm font-semibold text-danger">{t.assembly.inForbidden}</p>}
            <div className="mt-4 flex justify-between">
              <button className={secondary} onClick={() => goTo("forbidden")}>
                {t.back}
              </button>
              <button className={primary} disabled={!assembly || assemblyFar || assemblyForbidden} onClick={() => goTo("playlist")}>
                {t.next}
              </button>
            </div>
          </div>
        )}

        {step === "playlist" && (
          <div className={sheet}>
            <PlaylistEditor plan={plan} onChange={setPlan} chip={chip} />
            <div className="mt-4 flex justify-between gap-2">
              <button className={secondary} onClick={() => goTo("assembly")}>
                {t.back}
              </button>
              <button className={primary} disabled={!normPlan(plan)} onClick={() => goTo("safety")}>
                {t.playlist.next}
              </button>
            </div>
          </div>
        )}

        {step === "safety" && (
          <div className={sheet}>
            <p className="font-extrabold">{t.safety.lead}</p>
            <label className="mt-3 block">
              <span className="text-sm font-semibold">{t.safety.phone}</span>
              <input
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="912 34 567"
                className="mt-1 w-full rounded-xl border border-line bg-ink px-3 py-3 text-lg outline-none focus:border-gold"
              />
              <span className="mt-1 block text-xs text-txt-dim">{t.safety.phoneHint}</span>
            </label>

            <fieldset className="mt-4">
              <legend className="text-sm font-semibold">{t.safety.checklist}</legend>
              {t.safety.checks.map((label, i) => (
                <label key={label} className="mt-2 flex items-center gap-3 rounded-xl bg-ink px-3 py-2.5">
                  <input
                    type="checkbox"
                    checked={checks[i]}
                    onChange={(e) => setChecks((c) => c.map((v, j) => (j === i ? e.target.checked : v)))}
                    className="size-5 accent-gold"
                  />
                  <span className="font-semibold">{label}</span>
                </label>
              ))}
            </fieldset>
            <p className="mt-3 text-xs text-txt-dim">⚠️ {t.safety.traffic}</p>

            {createError && <p className="mt-3 text-sm font-semibold text-danger">{createError}</p>}
            <div className="mt-4 flex justify-between gap-2">
              <button className={secondary} onClick={() => goTo("playlist")} disabled={creating}>
                {t.back}
              </button>
              <button className={primary} disabled={!checks.every(Boolean) || creating} onClick={create}>
                {creating ? t.safety.creating : t.safety.create}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function DrawControls(props: {
  active: boolean;
  count: number;
  error: string | null;
  summary: string | null;
  onUndo: () => void;
  onClear: () => void;
  onFinish: () => void;
  onCancel?: () => void;
  onRedraw: () => void;
}) {
  const btn = "rounded-xl border border-line px-3 py-2.5 text-sm font-bold transition hover:bg-ink-3 disabled:opacity-40";
  if (!props.active) {
    return (
      <div className="mt-3 flex items-center justify-between">
        <span className="text-sm text-txt-dim">{props.summary}</span>
        <button className={btn} onClick={props.onRedraw}>
          ✏️ {t.area.redraw}
        </button>
      </div>
    );
  }
  return (
    <div className="mt-3">
      <p className="text-sm text-txt-dim">{t.area.drawHint}</p>
      {props.error && <p className="mt-2 text-sm font-semibold text-danger">{props.error}</p>}
      <div className="mt-3 flex gap-2">
        <button className={btn} disabled={props.count === 0} onClick={props.onUndo}>
          ↶ {t.area.undo}
        </button>
        <button className={btn} disabled={props.count === 0} onClick={props.onClear}>
          {t.area.clear}
        </button>
        {props.onCancel && (
          <button className={btn} onClick={props.onCancel}>
            {no.common.cancel}
          </button>
        )}
        <button
          className="ml-auto rounded-xl bg-gold px-4 py-2.5 text-sm font-extrabold text-ink disabled:opacity-40"
          disabled={props.count < 3}
          onClick={props.onFinish}
        >
          ✓ {t.area.finish}
        </button>
      </div>
    </div>
  );
}

const ROUND_MINUTES = [3, 4, 5, 6, 8, 10, 15];
const ROUND_KINDS = ["posts", "convert", "swap", "free"] as const;
const BREATHERS = [0, 30, 60, 90, 120];
const EVENT_EVERY = [0, 60, 90, 120] as const;
const QR_COUNTS = [0, 4, 6, 8, 12];

/** Playlist step (PLAN §13 phase 2): rounds with mode + length, breather, physical QR cards. */
function PlaylistEditor(props: { plan: Plan; onChange: (p: Plan) => void; chip: (on: boolean) => string }) {
  const { plan, onChange, chip } = props;
  const p = t.playlist;
  const setRound = (i: number, patch: Partial<Plan["rounds"][number]>) =>
    onChange({ ...plan, rounds: plan.rounds.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const move = (i: number) => {
    const rounds = [...plan.rounds];
    [rounds[i - 1], rounds[i]] = [rounds[i], rounds[i - 1]];
    onChange({ ...plan, rounds });
  };
  const iconBtn = "rounded-lg border border-line px-2.5 py-1.5 text-sm font-bold transition hover:bg-ink-3 disabled:opacity-30";
  return (
    <div>
      <p className="text-sm text-txt-dim">{p.lead}</p>
      <p className="mt-3 text-sm font-semibold">{p.templates}</p>
      <div className="mt-2 grid grid-cols-2 gap-1.5">
        {(Object.keys(TEMPLATES) as TemplateId[]).map((id) => (
          <button
            key={id}
            className={chip(JSON.stringify(plan.rounds) === JSON.stringify(TEMPLATES[id].rounds))}
            onClick={() => onChange(structuredClone(TEMPLATES[id]))}
            data-testid={`template-${id}`}
          >
            {p.template[id]}
          </button>
        ))}
      </div>
      <ol className="mt-3 space-y-2">
        {plan.rounds.map((r, i) => (
          <li key={i} className="rounded-xl bg-ink p-3">
            <div className="flex items-center gap-2">
              <span className="font-extrabold">{p.round(i + 1)}</span>
              <div className="ml-auto flex gap-1.5">
                <button className={iconBtn} disabled={i === 0} onClick={() => move(i)} aria-label={p.up}>
                  ↑
                </button>
                <button
                  className={iconBtn}
                  disabled={plan.rounds.length <= 1}
                  onClick={() => onChange({ ...plan, rounds: plan.rounds.filter((_, j) => j !== i) })}
                  aria-label={p.remove}
                >
                  ✕
                </button>
              </div>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-1.5">
              {ROUND_KINDS.map((k) => {
                const on = r.mode === "tag" ? r.variant === k : r.mode === k;
                return (
                  <button
                    key={k}
                    className={chip(on)}
                    onClick={() =>
                      setRound(i, k === "convert" || k === "swap" ? { mode: "tag", variant: k } : { mode: k as RoundMode, variant: undefined })
                    }
                  >
                    {p.modes[k]}
                  </button>
                );
              })}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {ROUND_MINUTES.map((m) => (
                <button
                  key={m}
                  className={`${chip(r.duration_s === m * 60)} flex-none px-2.5`}
                  onClick={() => setRound(i, { duration_s: m * 60 })}
                >
                  {p.minutes(m)}
                </button>
              ))}
            </div>
            <button
              className={`${chip(!!r.zone)} mt-2 w-full`}
              aria-pressed={!!r.zone}
              onClick={() => setRound(i, { zone: r.zone ? undefined : true })}
              data-testid={`zone-${i}`}
            >
              {p.zone}
            </button>
          </li>
        ))}
      </ol>
      <button
        className="mt-2 w-full rounded-xl border border-dashed border-line py-2.5 text-sm font-bold text-txt-dim transition hover:bg-ink-3 disabled:opacity-40"
        disabled={plan.rounds.length >= GAME.max_rounds}
        onClick={() => onChange({ ...plan, rounds: [...plan.rounds, { ...plan.rounds[plan.rounds.length - 1] }] })}
      >
        {p.add}
      </button>

      {plan.rounds.some((r) => r.zone) && <p className="mt-2 text-xs text-txt-dim">{p.zoneHint}</p>}

      <p className="mt-4 text-sm font-semibold">{p.breather}</p>
      <div className="mt-2 flex gap-1.5">
        {BREATHERS.map((b) => (
          <button key={b} className={chip(plan.breather_s === b)} onClick={() => onChange({ ...plan, breather_s: b })}>
            {b === 0 ? p.breatherNone : p.breatherS(b)}
          </button>
        ))}
      </div>

      {plan.rounds.some((r) => r.mode === "posts") && (
        <>
          <p className="mt-4 text-sm font-semibold">{p.qr}</p>
          <div className="mt-2 flex gap-1.5">
            {QR_COUNTS.map((n) => (
              <button key={n} className={chip(plan.qr_posts === n)} onClick={() => onChange({ ...plan, qr_posts: n })}>
                {n === 0 ? p.qrNone : n}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-txt-dim">{p.qrHint}</p>
        </>
      )}
      {/* Fase 4 (0007): automatic events, wizard default 90 s (ADR-024). */}
      <p className="mt-4 text-sm font-semibold">{no.events.wizard.label}</p>
      <div className="mt-2 flex gap-1.5">
        {EVENT_EVERY.map((n) => (
          <button key={n} className={chip((plan.event_every_s ?? 0) === n)} onClick={() => onChange({ ...plan, event_every_s: n || undefined })}>
            {n === 0 ? no.events.wizard.off : no.events.wizard.every(n)}
          </button>
        ))}
      </div>
      <p className="mt-1 text-xs text-txt-dim">{no.events.wizard.help}</p>
      <p className="mt-4 text-sm font-bold">{p.total(Math.round(planTotalS(plan) / 60))}</p>
    </div>
  );
}
