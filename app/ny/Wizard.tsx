"use client";

import "maplibre-gl/dist/maplibre-gl.css";

import type { GeoJSONSource, Map as MlMap, Marker } from "maplibre-gl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { ApiError, api, type LibArea, type LibPlan, type Library } from "@/lib/client/api";
import { AreaThumb } from "@/lib/client/AreaThumb";
import { QuizEditor } from "@/lib/client/QuizEditor";
import { Button, Chip, Stepper, cx } from "@/lib/client/ui";
import { planSummary } from "@/lib/client/planSummary";
import { normMissions } from "@/lib/rules/library";
import { STARTER_PACKS, type StarterPack } from "@/lib/starter";
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
import { TEAMS, isTeamRound } from "@/lib/rules/teams";
import { loadMapLibre } from "@/lib/map/maplibre";
import { DEFAULT_CENTER, kartverketStyle } from "@/lib/map/style";

const t = no.wizard;

type Step = "intro" | "start" | "area" | "forbidden" | "assembly" | "playlist" | "safety";
type AreaMode = "circle" | "draw";
type DrawTarget = "area" | "forbidden" | null;

const STEPS: Step[] = ["area", "forbidden", "assembly", "playlist", "safety"];
const ORDER: Step[] = ["intro", "start", ...STEPS];
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
  // 0010: the teacher's library (for «Gjenbruk forrige», picking, mission packs).
  const [library, setLibrary] = useState<Library | null>(null);
  const [startView, setStartView] = useState<"menu" | "library" | "starter">("menu");
  const [quizValid, setQuizValid] = useState(true);
  const [pickArea, setPickArea] = useState<string | null>(null);
  const [pickPlan, setPickPlan] = useState<string | null>(null);
  const wanted = useRef<{ area: string | null; plan: string | null } | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // Presentation only: slide direction, folded map sheet, folded extras (D).
  const [dir, setDir] = useState<"next" | "back">("next");
  const [collapsed, setCollapsed] = useState(false);
  const [openMissions, setOpenMissions] = useState(false);
  const [openQuiz, setOpenQuiz] = useState(false);

  // First visit: introduce + show the lærernøkkel once. Then the start menu
  // (0010) — or straight to the area when /ny?area=…&plan=… came from the library.
  useEffect(() => {
    const { key } = identity.ensureTeacherKey();
    const q = new URLSearchParams(window.location.search);
    const area = q.get("area");
    const plan = q.get("plan");
    if (area || plan) wanted.current = { area, plan };
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reading localStorage after mount
    setTeacherKey(key);
    setStep(!identity.hasSeenIntro() ? "intro" : wanted.current ? "area" : "start");
    api.library.get(key).then(setLibrary).catch(() => setLibrary(null));
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
          paint: { "line-color": "#14171e", "line-width": 2.5, "line-dasharray": [2, 1.5] },
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
      {
        // The sheet docks left on wide screens and at the bottom on phones.
        padding: window.matchMedia("(min-width: 1024px)").matches
          ? { top: 80, left: 500, right: 80, bottom: 60 }
          : { top: 90, left: 40, right: 60, bottom: 360 },
        maxZoom: 18,
        duration: 500,
      },
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
    setDir(ORDER.indexOf(next) < ORDER.indexOf(step) ? "back" : "next");
    setCollapsed(false);
    setStep(next);
    if (next !== "intro" && next !== "start") setTimeout(fitArea, 0);
  }

  // ── 0010: library / start packs ──
  function applyArea(a: LibArea) {
    const ring = a.boundary.coordinates[0].map((p) => [p[0], p[1]] as LngLat);
    setAreaMode("draw");
    setDrawnArea(ring.slice(0, -1));
    setForbidden((a.forbidden?.coordinates ?? []).map((poly) => poly[0].slice(0, -1).map((p) => [p[0], p[1]] as LngLat)));
    setAssembly([a.assembly.lng, a.assembly.lat]);
    map.current?.jumpTo({ center: [a.assembly.lng, a.assembly.lat] });
  }
  function applyPlan(p: LibPlan) {
    setPlan(structuredClone(p.plan));
  }
  function applyStarter(pack: StarterPack) {
    setPlan(structuredClone(pack.plan));
    setAreaMode("circle");
    setRadius(pack.radius_m);
    goTo("area");
  }
  const lastArea = library?.areas.reduce<LibArea | null>((b, a) => (!b || a.last_used_at > b.last_used_at ? a : b), null) ?? null;
  const lastPlan = library?.plans.reduce<LibPlan | null>((b, a) => (!b || a.last_used_at > b.last_used_at ? a : b), null) ?? null;

  // /ny?area=…&plan=… (from the library or a share copy): apply once it has loaded.
  useEffect(() => {
    if (!library || !wanted.current) return;
    const w = wanted.current;
    wanted.current = null;
    const a = library.areas.find((x) => x.id === w.area);
    const p = library.plans.find((x) => x.id === w.plan);
     
    if (a) applyArea(a);
    if (p) applyPlan(p);
     
  }, [library]);
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
  const onMap = step === "area" || step === "forbidden" || step === "assembly";
  const tall = !onMap;
  const isCollapsed = onMap && collapsed && !drawTarget;
  const stepCls = dir === "back" ? "t-step-back" : "t-step-next";
  const p = t.playlist;
  const missionCount = plan.missions?.length ?? 0;
  const missionsBad = missionCount > 0 && normMissions(plan.missions) === null;
  const quizCount = plan.quiz?.length ?? 0;
  const allChecked = checks.every(Boolean);

  const head = (title: string) => (
    <div className="flex items-start gap-3">
      <h2 className="min-w-0 flex-1 pt-2.5 text-lg leading-snug font-extrabold">{title}</h2>
      {!drawTarget && (
        <button
          type="button"
          className="ui-press -mt-1 -mr-2 grid size-12 flex-none place-items-center rounded-full text-txt-dim hover:bg-ink-3 hover:text-txt"
          aria-expanded={!collapsed}
          aria-label={collapsed ? t.sheetShow : t.sheetHide}
          onClick={() => setCollapsed((c) => !c)}
        >
          <Chevron className="t-chevron rotate-180" />
        </button>
      )}
    </div>
  );

  return (
    <div className="relative h-dvh w-full overflow-hidden">
      <div className="absolute inset-0">
        <div ref={container} className="h-full w-full" />
      </div>

      {/* top: close + progress */}
      {step !== "intro" && step !== "start" && (
        <div className="pointer-events-none absolute inset-x-0 top-0 p-3 pt-[max(0.75rem,env(safe-area-inset-top))] lg:right-auto lg:w-[28rem]">
          <div className="m-drop-in pointer-events-auto mr-14 flex items-center gap-2 rounded-full bg-ink-2/95 py-1 pr-4 pl-1 shadow-[var(--shadow-float)] backdrop-blur lg:mr-0">
            <Link
              href="/"
              className="ui-press grid size-12 flex-none place-items-center rounded-full text-lg text-txt-dim hover:bg-ink-3 hover:text-txt"
              aria-label={no.common.home}
            >
              ✕
            </Link>
            <div className="min-w-0 flex-1 whitespace-nowrap" aria-label={t.title}>
              <Stepper count={STEPS.length} index={idx} label={t.steps[idx]} />
            </div>
          </div>
        </div>
      )}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:inset-y-0 lg:right-auto lg:flex lg:w-[28rem] lg:flex-col lg:justify-end lg:pt-24">
        <div
          className={cx(
            "m-sheet-in pointer-events-auto mx-auto w-full max-w-md overflow-y-auto overscroll-contain rounded-[1.75rem] bg-ink-2 shadow-[var(--shadow-float)] transition-[max-height] duration-[var(--dur-3)] ease-[var(--ease-out)] lg:max-w-none",
            tall ? "max-h-[82dvh] lg:max-h-full" : "max-h-[50dvh] lg:max-h-full",
          )}
        >
          <div key={step} className={cx("p-5", stepCls)} data-testid={step === "start" ? "start-step" : undefined}>
            {step === "intro" && (
              <>
                <h1 className="text-2xl font-black">{t.intro.title}</h1>
                <p className="mt-2 leading-relaxed text-txt-dim">{t.intro.body}</p>
                <div className="mt-5 rounded-2xl border border-gold/50 bg-gold/10 p-4">
                  <p className="text-sm font-extrabold text-gold-text">🔑 {t.intro.keyTitle}</p>
                  <p className="mt-1 font-mono text-xl font-bold tracking-wider break-all" data-testid="teacher-key">
                    {teacherKey}
                  </p>
                  <p className="mt-2 text-sm leading-relaxed text-txt-dim">{t.intro.keyBody}</p>
                </div>
                <Button
                  size="lg"
                  className="mt-5 w-full"
                  onClick={() => {
                    identity.markIntroSeen();
                    goTo(wanted.current ? "area" : "start");
                  }}
                >
                  {t.intro.start}
                </Button>
              </>
            )}

            {step === "start" && (
              <div key={startView} className="t-step-next" data-testid="start-step">
                {startView === "menu" && (
                  <>
                    <h1 className="text-2xl font-black">{no.start.title}</h1>
                    <div className="m-stagger mt-4 grid gap-2.5">
                      {lastArea && lastPlan && (
                        <button
                          className={optionGold}
                          onClick={() => {
                            applyArea(lastArea);
                            applyPlan(lastPlan);
                            goTo("safety");
                          }}
                          data-testid="start-reuse"
                          style={{ "--i": 0 } as React.CSSProperties}
                        >
                          {no.start.reuse}
                          <span className="block w-full truncate text-sm font-bold opacity-75">
                            {no.start.reuseHint(lastArea.name, planSummary(lastPlan.plan).modes)}
                          </span>
                        </button>
                      )}
                      {library && (library.areas.length > 0 || library.plans.length > 0) && (
                        <button className={option} onClick={() => setStartView("library")} data-testid="start-library" style={{ "--i": 1 } as React.CSSProperties}>
                          {no.start.fromLibrary}
                        </button>
                      )}
                      <button className={option} onClick={() => setStartView("starter")} data-testid="start-starter" style={{ "--i": 2 } as React.CSSProperties}>
                        {no.start.starter}
                      </button>
                      <button className={option} onClick={() => goTo("area")} data-testid="start-fresh" style={{ "--i": 3 } as React.CSSProperties}>
                        {no.start.fresh}
                      </button>
                    </div>
                    <Link href="/bibliotek" className="mt-3 inline-flex min-h-12 items-center text-sm font-bold text-txt-dim underline underline-offset-4 hover:text-txt">
                      {no.library.title}
                    </Link>
                  </>
                )}
                {startView === "starter" && (
                  <>
                    <h1 className="text-xl font-black">{no.start.starter}</h1>
                    <p className="mt-1 text-sm leading-relaxed text-txt-dim">{no.start.starterLead}</p>
                    <div className="m-stagger mt-4 grid gap-2.5">
                      {STARTER_PACKS.map((pk, i) => (
                        <button
                          key={pk.id}
                          className={option}
                          onClick={() => applyStarter(pk)}
                          data-testid={`starter-${pk.id}`}
                          style={{ "--i": i } as React.CSSProperties}
                        >
                          <span className="font-extrabold">
                            {pk.emoji} {pk.name}
                          </span>
                          <span className="block text-sm font-normal text-txt-dim">{pk.lead}</span>
                          <span className="mt-1 block text-xs font-bold text-gold-text">
                            {no.start.radius(pk.radius_m)} · {planSummary(pk.plan).modes}
                          </span>
                        </button>
                      ))}
                    </div>
                    <Button variant="ghost" className="mt-3" onClick={() => setStartView("menu")}>
                      ← {no.start.back}
                    </Button>
                  </>
                )}
                {startView === "library" && library && (
                  <>
                    <h2 className="text-sm font-bold tracking-wide text-txt-dim uppercase">{no.start.pickArea}</h2>
                    <div className="mt-2 grid gap-2">
                      <button className={choice(pickArea === null, "w-full min-w-0 text-left")} onClick={() => setPickArea(null)}>
                        {no.start.noArea}
                      </button>
                      {library.areas.map((a) => (
                        <button key={a.id} className={choice(pickArea === a.id, "flex w-full min-w-0 items-center gap-3 py-1.5 text-left")} onClick={() => setPickArea(a.id)}>
                          <AreaThumb area={a} size={36} />
                          <span className="truncate">{a.name}</span>
                        </button>
                      ))}
                    </div>
                    <h2 className="mt-5 text-sm font-bold tracking-wide text-txt-dim uppercase">{no.start.pickPlan}</h2>
                    <div className="mt-2 grid gap-2">
                      <button className={choice(pickPlan === null, "w-full min-w-0 text-left")} onClick={() => setPickPlan(null)}>
                        {no.start.noPlan}
                      </button>
                      {library.plans.map((pl) => (
                        <button key={pl.id} className={choice(pickPlan === pl.id, "w-full min-w-0 py-2 text-left")} onClick={() => setPickPlan(pl.id)}>
                          <span className="block truncate">{pl.name}</span>
                          <span className="block truncate text-xs font-bold opacity-75">{planSummary(pl.plan).modes}</span>
                        </button>
                      ))}
                    </div>
                    <SheetFooter>
                      <Button variant="ghost" onClick={() => setStartView("menu")}>
                        ← {no.start.back}
                      </Button>
                      <Button
                        onClick={() => {
                          const a = library.areas.find((x) => x.id === pickArea);
                          const pl = library.plans.find((x) => x.id === pickPlan);
                          if (a) applyArea(a);
                          if (pl) applyPlan(pl);
                          goTo("area");
                        }}
                        data-testid="start-library-go"
                      >
                        {no.start.go}
                      </Button>
                    </SheetFooter>
                  </>
                )}
              </div>
            )}

            {step === "area" && (
              <>
                {head(t.area.lead)}
                {!isCollapsed && (
                  <div className="m-fade-in">
                    {!drawTarget && (
                      <div className="mt-3 flex gap-2 rounded-[var(--radius-ctl)] bg-ink p-1" role="group">
                        <button className={segment(areaMode === "circle")} aria-pressed={areaMode === "circle"} onClick={() => setAreaMode("circle")}>
                          ◎ {t.area.circle}
                        </button>
                        <button
                          className={segment(areaMode === "draw")}
                          aria-pressed={areaMode === "draw"}
                          onClick={() => {
                            setAreaMode("draw");
                            if (!drawnArea) startDraw("area");
                          }}
                        >
                          ✏️ {t.area.draw}
                        </button>
                      </div>
                    )}

                    {areaMode === "circle" && (
                      <>
                        {gpsState === "locating" && !circleCentre && <p className="mt-3 text-sm text-txt-dim">{t.area.locating}</p>}
                        {gpsState === "error" && <Note tone="warn">{t.area.noGps}</Note>}
                        <label className="mt-4 block">
                          <span className="flex items-baseline justify-between text-sm font-bold">
                            <span>{t.area.radius(radius)}</span>
                            <span className="font-semibold text-txt-dim">{no.map.area(areaM2)}</span>
                          </span>
                          <input
                            type="range"
                            min={50}
                            max={400}
                            step={10}
                            value={radius}
                            onChange={(e) => setRadius(Number(e.target.value))}
                            className="mt-1 h-12 w-full cursor-pointer accent-gold"
                          />
                        </label>
                        <Button
                          variant="ghost"
                          className="-ml-3 text-sm text-txt-dim"
                          onClick={() => {
                            const c = map.current?.getCenter();
                            if (c) setCircleCentre([c.lng, c.lat]);
                          }}
                        >
                          ⌖ {t.area.useMapCentre}
                        </Button>
                      </>
                    )}

                    {areaMode === "draw" && (
                      <DrawControls
                        active={drawTarget === "area"}
                        tone="area"
                        count={draft.length}
                        error={draftError}
                        onUndo={() => setDraft((d) => d.slice(0, -1))}
                        onClear={() => setDraft([])}
                        onFinish={finishDraw}
                        onCancel={
                          drawnArea
                            ? cancelDraw
                            : () => {
                                // No polygon yet: «Avbryt» goes back to the circle instead of trapping the teacher in draw mode.
                                cancelDraw();
                                setAreaMode("circle");
                              }
                        }
                        summary={drawnArea && drawTarget !== "area" ? no.map.area(areaM2) : null}
                        onRedraw={() => startDraw("area")}
                      />
                    )}

                    {areaWarning && !drawTarget && <Note tone="warn">{areaWarning}</Note>}
                  </div>
                )}
                {!drawTarget && (
                  <div className={cx("flex justify-end", isCollapsed ? "mt-2" : "mt-5")}>
                    <Button size="lg" className="min-w-36" disabled={areaBlocked} onClick={() => goTo("forbidden")}>
                      {t.next} →
                    </Button>
                  </div>
                )}
              </>
            )}

            {step === "forbidden" && (
              <>
                {head(t.forbidden.lead)}
                {drawTarget === "forbidden" ? (
                  <DrawControls
                    active
                    tone="forbidden"
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
                    {!isCollapsed && (
                      <div className="m-fade-in">
                        <ul className="mt-3 space-y-2">
                          {forbidden.length === 0 && (
                            <li className="rounded-2xl border border-dashed border-line px-4 py-3 text-sm text-txt-dim">{t.forbidden.none}</li>
                          )}
                          {forbidden.map((r, i) => (
                            <li key={i} className="m-rise-in flex min-h-14 items-center justify-between gap-2 rounded-2xl bg-ink pr-1 pl-4">
                              <span className="flex min-w-0 items-center gap-2.5 font-bold">
                                <span className="size-3.5 flex-none rounded-[4px] bg-danger" aria-hidden />
                                {t.forbidden.zone(i + 1)}
                                <span className="truncate text-sm font-normal text-txt-dim">{no.map.area(ringArea(r))}</span>
                              </span>
                              <button
                                className="ui-press min-h-12 rounded-[var(--radius-ctl)] px-3 text-sm font-bold text-danger-text hover:bg-danger/10"
                                onClick={() => setForbidden((f) => f.filter((_, j) => j !== i))}
                              >
                                {t.forbidden.remove}
                              </button>
                            </li>
                          ))}
                        </ul>
                        <Button variant="secondary" className="mt-3 w-full" onClick={() => startDraw("forbidden")}>
                          ＋ {t.forbidden.add}
                        </Button>
                      </div>
                    )}
                    <SheetFooter plain={isCollapsed}>
                      <Button variant="ghost" onClick={() => goTo("area")}>
                        ← {t.back}
                      </Button>
                      <Button size="lg" className="min-w-36" onClick={() => goTo("assembly")}>
                        {forbidden.length ? `${t.next} →` : t.skip}
                      </Button>
                    </SheetFooter>
                  </>
                )}
              </>
            )}

            {step === "assembly" && (
              <>
                {head(t.assembly.lead)}
                {!isCollapsed && (
                  <div className="m-fade-in">
                    <div className="mt-3 flex gap-2">
                      <button className={choice(false, "flex-1")} disabled={!me} onClick={() => me && setAssembly(me)}>
                        📍 {t.assembly.here}
                      </button>
                      <button className={choice(false, "flex-1")} onClick={() => areaRing && setAssembly(defaultAssembly(areaRing, forbidden))}>
                        ◎ {t.assembly.centre}
                      </button>
                    </div>
                    {assemblyFar && <Note tone="danger">{t.assembly.far}</Note>}
                    {assemblyForbidden && <Note tone="danger">{t.assembly.inForbidden}</Note>}
                  </div>
                )}
                <SheetFooter plain={isCollapsed}>
                  <Button variant="ghost" onClick={() => goTo("forbidden")}>
                    ← {t.back}
                  </Button>
                  <Button size="lg" className="min-w-36" disabled={!assembly || assemblyFar || assemblyForbidden} onClick={() => goTo("playlist")}>
                    {t.next} →
                  </Button>
                </SheetFooter>
              </>
            )}

            {step === "playlist" && (
              <>
                <h2 className="text-xl font-black">{p.roundsTitle}</h2>
                <PlaylistEditor plan={plan} onChange={setPlan} choice={choice} />

                {/* (D) Optional extras, folded away by default. Both editors stay
                    mounted while folded so their text and validity survive. */}
                <section className="mt-7 border-t border-line pt-5" data-testid="extras">
                  <h2 className="text-xl font-black">{p.extras}</h2>
                  <p className="mt-0.5 text-sm text-txt-dim">{p.extrasLead}</p>

                  <Disclosure
                    title={no.missions.title}
                    open={openMissions}
                    onToggle={() => setOpenMissions((o) => !o)}
                    testId="extras-missions"
                    badge={
                      missionsBad ? (
                        <Chip tone="warn">{p.fix}</Chip>
                      ) : missionCount ? (
                        <Chip tone="gold">{p.missionsN(missionCount)}</Chip>
                      ) : (
                        <Chip>{p.missionsDefault}</Chip>
                      )
                    }
                  >
                    <MissionsEditor
                      plan={plan}
                      onChange={setPlan}
                      packs={library?.packs ?? []}
                      onSavePack={async (name, items) => {
                        if (!teacherKey) return false;
                        try {
                          await api.library.save(teacherKey, "pack", name, { items });
                          setLibrary(await api.library.get(teacherKey));
                          return true;
                        } catch {
                          return false;
                        }
                      }}
                    />
                  </Disclosure>

                  <Disclosure
                    title={p.quizTitle}
                    open={openQuiz}
                    onToggle={() => setOpenQuiz((o) => !o)}
                    testId="extras-quiz"
                    badge={
                      !quizValid ? (
                        <Chip tone="warn">{p.fix}</Chip>
                      ) : quizCount ? (
                        <Chip tone="gold">{no.quiz.count(quizCount)}</Chip>
                      ) : (
                        <Chip>{p.quizNone}</Chip>
                      )
                    }
                  >
                    <p className="text-sm leading-relaxed text-txt-dim">{no.quiz.editorLead}</p>
                    <QuizEditor
                      compact
                      items={plan.quiz}
                      packs={library?.quizzes ?? []}
                      onChange={(items, valid) => {
                        setQuizValid(valid);
                        setPlan((p) => {
                          const { quiz: _q, ...rest } = p;
                          void _q;
                          return items ? { ...rest, quiz: items } : rest;
                        });
                      }}
                      onSavePack={async (name, items) => {
                        if (!teacherKey) return false;
                        try {
                          await api.library.save(teacherKey, "quiz", name, { items });
                          setLibrary(await api.library.get(teacherKey));
                          return true;
                        } catch {
                          return false;
                        }
                      }}
                    />
                  </Disclosure>
                  {plan.quiz?.length && !plan.rounds.some((r) => r.mode === "posts") ? <Note tone="warn">{no.quiz.needsPosts}</Note> : null}
                </section>

                <SheetFooter>
                  <Button variant="ghost" onClick={() => goTo("assembly")}>
                    ← {t.back}
                  </Button>
                  <Button size="lg" className="min-w-36" disabled={!normPlan(plan) || !quizValid} onClick={() => goTo("safety")}>
                    {p.next} →
                  </Button>
                </SheetFooter>
              </>
            )}

            {step === "safety" && (
              <>
                <h2 className="text-xl font-black">{t.safety.lead}</h2>

                <div className="mt-4 flex gap-3 rounded-2xl border border-warn/40 bg-warn/15 p-4 text-warn-text" role="note">
                  <span className="text-xl leading-none" aria-hidden>
                    ⚠️
                  </span>
                  <p className="text-sm leading-relaxed font-bold">{t.safety.traffic}</p>
                </div>

                <fieldset className="mt-5">
                  <legend className="flex w-full items-center justify-between text-sm font-bold">
                    <span>{t.safety.checklist}</span>
                    <span className={cx("tabular-nums", allChecked ? "text-ok-text" : "text-txt-dim")}>
                      {checks.filter(Boolean).length}/{checks.length}
                    </span>
                  </legend>
                  <div className="mt-2 space-y-2">
                    {t.safety.checks.map((label, i) => (
                      <label
                        key={label}
                        className={cx(
                          "t-check flex min-h-14 cursor-pointer items-center gap-3 rounded-2xl border px-4 py-2",
                          checks[i] ? "border-ok/50 bg-ok/10" : "border-line bg-ink-2 hover:bg-ink",
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={checks[i]}
                          onChange={(e) => setChecks((c) => c.map((v, j) => (j === i ? e.target.checked : v)))}
                          className="size-6 flex-none accent-[var(--color-ok-text)]"
                        />
                        <span className="font-semibold">{label}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>

                <label className="mt-5 block">
                  <span className="text-sm font-bold">{t.safety.phone}</span>
                  <input
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="912 34 567"
                    className={cx(field, "mt-1.5 text-lg")}
                  />
                  <span className="mt-1.5 block text-xs leading-relaxed text-txt-dim">{t.safety.phoneHint}</span>
                </label>

                {!allChecked && <p className="mt-4 text-sm text-txt-dim">{t.safety.checkAll}</p>}
                {createError && (
                  <Note tone="danger" alert>
                    {createError}
                  </Note>
                )}
                <SheetFooter>
                  <Button variant="ghost" onClick={() => goTo("playlist")} disabled={creating}>
                    ← {t.back}
                  </Button>
                  <Button size="lg" className="min-w-0 flex-1 sm:flex-none" disabled={!allChecked || creating} onClick={create}>
                    {creating ? t.safety.creating : t.safety.create}
                  </Button>
                </SheetFooter>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── presentation helpers ─────────────────────────────────────────────── */

const field =
  "w-full min-h-12 rounded-[var(--radius-ctl)] border border-line bg-ink px-4 py-2.5 outline-none transition-[border-color,box-shadow] duration-[var(--dur-1)] focus:border-gold-deep focus:ring-4 focus:ring-gold/20";
const optionBase = "ui-press flex min-h-14 w-full min-w-0 flex-col items-start justify-center rounded-[var(--radius-ctl)] px-4 py-3 text-left font-extrabold";
const option = cx(optionBase, "border border-line bg-ink-2 hover:border-gold/60 hover:bg-ink");
const optionGold = cx(optionBase, "bg-gold text-on-accent shadow-[var(--shadow-card)] hover:bg-gold-light");

/** Selectable chip-button (rounds, minutes, pickers). */
function choice(on: boolean, extra?: string) {
  return cx(
    "ui-press min-h-12 rounded-[var(--radius-ctl)] px-3 text-sm font-extrabold disabled:opacity-40",
    on ? "bg-gold text-on-accent shadow-[var(--shadow-card)]" : "border border-line bg-ink-2 text-txt hover:bg-ink-3",
    extra,
  );
}
/** One half of a segmented control. */
function segment(on: boolean) {
  return cx(
    "ui-press min-h-12 flex-1 rounded-[0.7rem] px-3 text-sm font-extrabold",
    on ? "bg-ink-2 text-txt shadow-[var(--shadow-card)]" : "text-txt-dim hover:text-txt",
  );
}

function Note({ tone, alert, children }: { tone: "warn" | "danger"; alert?: boolean; children: React.ReactNode }) {
  return (
    <p
      className={cx(
        "m-rise-in mt-3 rounded-xl px-3.5 py-2.5 text-sm leading-relaxed font-semibold",
        tone === "warn" ? "bg-warn/15 text-warn-text" : "bg-danger/10 text-danger-text",
      )}
      role={alert ? "alert" : undefined}
    >
      {children}
    </p>
  );
}

/** Back/next row that sticks to the bottom of a scrolling sheet. */
function SheetFooter({ children, plain }: { children: React.ReactNode; plain?: boolean }) {
  return (
    <div
      className={cx(
        "flex items-center justify-between gap-2",
        plain ? "mt-2" : "sticky bottom-0 -mx-5 -mb-5 mt-5 border-t border-line bg-ink-2/95 px-5 py-3 backdrop-blur",
      )}
    >
      {children}
    </div>
  );
}

function Chevron({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" className={className} aria-hidden>
      <path d="M5 8l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Disclosure(props: {
  title: string;
  badge: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  testId: string;
  children: React.ReactNode;
}) {
  const id = useId();
  return (
    <div className={cx("mt-3 rounded-2xl border bg-ink-2 transition-colors duration-[var(--dur-2)]", props.open ? "border-gold/50" : "border-line")}>
      <button
        type="button"
        className="ui-press flex min-h-14 w-full items-center gap-3 rounded-2xl px-4 text-left hover:bg-ink"
        aria-expanded={props.open}
        aria-controls={id}
        onClick={props.onToggle}
        data-testid={props.testId}
      >
        <span className="min-w-0 flex-1 font-extrabold">{props.title}</span>
        {props.badge}
        <Chevron className="t-chevron flex-none text-txt-dim" />
      </button>
      <div id={id} className="t-collapse" data-open={props.open} inert={!props.open}>
        <div>
          <div className="px-4 pt-1 pb-4">{props.children}</div>
        </div>
      </div>
    </div>
  );
}

function DrawControls(props: {
  active: boolean;
  tone: "area" | "forbidden";
  count: number;
  error: string | null;
  summary: string | null;
  onUndo: () => void;
  onClear: () => void;
  onFinish: () => void;
  onCancel?: () => void;
  onRedraw: () => void;
}) {
  const btn = "flex-1 px-3 text-sm";
  if (!props.active) {
    return (
      <div className="mt-3 flex items-center justify-between gap-3 rounded-2xl bg-ink py-1 pr-1 pl-4">
        <span className="text-sm font-semibold text-txt-dim">{props.summary}</span>
        <Button variant="ghost" className="text-sm" onClick={props.onRedraw}>
          ✏️ {t.area.redraw}
        </Button>
      </div>
    );
  }
  return (
    <div className="m-fade-in mt-3">
      <p className="flex items-start gap-2 text-sm leading-relaxed text-txt-dim">
        <span className={cx("mt-1 size-2.5 flex-none rounded-full", props.tone === "area" ? "bg-gold" : "bg-danger")} aria-hidden />
        <span className="flex-1">{t.area.drawHint}</span>
        <Chip tone={props.count >= 3 ? "ok" : "neutral"}>{t.area.corners(props.count)}</Chip>
      </p>
      {props.error && <Note tone="danger">{props.error}</Note>}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="secondary" className={btn} disabled={props.count === 0} onClick={props.onUndo}>
          ↶ {t.area.undo}
        </Button>
        <Button variant="secondary" className={btn} disabled={props.count === 0} onClick={props.onClear}>
          {t.area.clear}
        </Button>
        {props.onCancel && (
          <Button variant="ghost" className={btn} onClick={props.onCancel}>
            {no.common.cancel}
          </Button>
        )}
        <Button className={cx(btn, "min-w-24")} disabled={props.count < 3} onClick={props.onFinish}>
          ✓ {t.area.finish}
        </Button>
      </div>
    </div>
  );
}

const ROUND_MINUTES = [3, 4, 5, 6, 8, 10, 15];
const ROUND_KINDS = ["posts", "convert", "swap", "fox", "free", "flag", "king", "relay"] as const;
const TEAM_COUNTS = [2, 3, 4] as const;
const BREATHERS = [0, 30, 60, 90, 120];
const EVENT_EVERY = [0, 60, 90, 120] as const;
const QR_COUNTS = [0, 4, 6, 8, 12];

function Label({ children }: { children: React.ReactNode }) {
  return <p className="mt-5 text-sm font-bold">{children}</p>;
}
function Help({ children }: { children: React.ReactNode }) {
  return <p className="mt-1.5 text-xs leading-relaxed text-txt-dim">{children}</p>;
}

/** Playlist step (PLAN §13 phase 2): rounds with mode + length, breather, physical QR cards. */
function PlaylistEditor(props: { plan: Plan; onChange: (p: Plan) => void; choice: (on: boolean, extra?: string) => string }) {
  const { plan, onChange, choice } = props;
  const p = t.playlist;
  const setRound = (i: number, patch: Partial<Plan["rounds"][number]>) =>
    onChange({ ...plan, rounds: plan.rounds.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const move = (i: number) => {
    const rounds = [...plan.rounds];
    [rounds[i - 1], rounds[i]] = [rounds[i], rounds[i - 1]];
    onChange({ ...plan, rounds });
  };
  const iconBtn = "ui-press grid size-12 place-items-center rounded-[var(--radius-ctl)] text-base font-bold text-txt-dim hover:bg-ink-3 hover:text-txt disabled:opacity-30";
  return (
    <div>
      <p className="mt-1 text-sm leading-relaxed text-txt-dim">{p.lead}</p>
      <Label>{p.templates}</Label>
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {(Object.keys(TEMPLATES) as TemplateId[]).map((id) => (
          <button
            key={id}
            className={choice(JSON.stringify(plan.rounds) === JSON.stringify(TEMPLATES[id].rounds), "text-left")}
            onClick={() => onChange(structuredClone(TEMPLATES[id]))}
            data-testid={`template-${id}`}
          >
            {p.template[id]}
          </button>
        ))}
      </div>
      <ol className="mt-4 space-y-3">
        {plan.rounds.map((r, i) => (
          <li key={i} className="m-rise-in rounded-2xl border border-line bg-ink p-3">
            <div className="flex items-center gap-2">
              <span className="grid size-8 place-items-center rounded-full bg-ink-2 text-sm font-black shadow-[var(--shadow-card)]">{i + 1}</span>
              <span className="font-extrabold">{p.round(i + 1)}</span>
              <div className="-my-1 ml-auto flex">
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
            <div className="mt-2 grid grid-cols-2 gap-2">
              {ROUND_KINDS.map((k) => {
                const on = r.mode === "tag" ? r.variant === k : r.mode === k;
                return (
                  <button
                    key={k}
                    className={choice(on, "text-left")}
                    onClick={() =>
                      setRound(
                        i,
                        k === "convert" || k === "swap" || k === "fox"
                          ? { mode: "tag", variant: k, team: undefined }
                          : k === "flag" || k === "king" || k === "relay"
                            ? { mode: k, variant: undefined, zone: undefined, team: undefined }
                            : { mode: k as RoundMode, variant: undefined },
                      )
                    }
                  >
                    {p.modes[k]}
                  </button>
                );
              })}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {ROUND_MINUTES.map((m) => (
                <button key={m} className={choice(r.duration_s === m * 60, "min-w-14 flex-1 px-2")} onClick={() => setRound(i, { duration_s: m * 60 })}>
                  {p.minutes(m)}
                </button>
              ))}
            </div>
            {r.mode !== "flag" && r.mode !== "king" && r.mode !== "relay" && (
              <div className="mt-2 flex gap-2">
                <button
                  className={choice(!!r.zone, "flex-1")}
                  aria-pressed={!!r.zone}
                  onClick={() => setRound(i, { zone: r.zone ? undefined : true })}
                  data-testid={`zone-${i}`}
                >
                  {p.zone}
                </button>
                {(r.mode === "posts" || r.mode === "free") && (
                  <button
                    className={choice(!!r.team, "flex-1")}
                    aria-pressed={!!r.team}
                    onClick={() => setRound(i, { team: r.team ? undefined : true })}
                    data-testid={`team-${i}`}
                  >
                    {p.team}
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ol>
      <button
        className="ui-press mt-3 min-h-12 w-full rounded-2xl border-2 border-dashed border-line text-sm font-bold text-txt-dim hover:border-gold/60 hover:bg-ink hover:text-txt disabled:opacity-40"
        disabled={plan.rounds.length >= GAME.max_rounds}
        onClick={() => onChange({ ...plan, rounds: [...plan.rounds, { ...plan.rounds[plan.rounds.length - 1] }] })}
      >
        {p.add}
      </button>

      {plan.rounds.some((r) => r.zone) && <Help>{p.zoneHint}</Help>}
      {plan.rounds.some((r) => r.mode === "tag" && r.variant === "fox") && <Help>{p.foxHint}</Help>}

      {/* Fase 5 (0009): number of teams when the playlist has a team round. */}
      {plan.rounds.some((r) => isTeamRound(r)) && (
        <>
          <Label>{p.teams}</Label>
          <div className="mt-2 flex gap-2">
            {TEAM_COUNTS.map((n) => (
              <button
                key={n}
                className={choice((plan.teams ?? TEAMS.teams_default) === n, "flex-1")}
                onClick={() => onChange({ ...plan, teams: n })}
                data-testid={`teams-${n}`}
              >
                {p.teamsN(n)}
              </button>
            ))}
          </div>
          <Help>{p.teamsHint}</Help>
          {plan.rounds.map((r, i) =>
            r.mode === "flag" || r.mode === "king" || r.mode === "relay" ? (
              <Help key={i}>
                {p.round(i + 1)}: {p.modeHint[r.mode]}
              </Help>
            ) : null,
          )}
        </>
      )}

      <Label>{p.breather}</Label>
      <div className="mt-2 flex gap-2">
        {BREATHERS.map((b) => (
          <button key={b} className={choice(plan.breather_s === b, "flex-1 px-1")} onClick={() => onChange({ ...plan, breather_s: b })}>
            {b === 0 ? p.breatherNone : p.breatherS(b)}
          </button>
        ))}
      </div>

      {plan.rounds.some((r) => r.mode === "posts") && (
        <>
          <Label>{p.qr}</Label>
          <div className="mt-2 flex gap-2">
            {QR_COUNTS.map((n) => (
              <button key={n} className={choice(plan.qr_posts === n, "flex-1 px-1")} onClick={() => onChange({ ...plan, qr_posts: n })}>
                {n === 0 ? p.qrNone : n}
              </button>
            ))}
          </div>
          <Help>{p.qrHint}</Help>
        </>
      )}
      {/* Fase 4 (0007): automatic events, wizard default 90 s (ADR-024). */}
      <Label>{no.events.wizard.label}</Label>
      <div className="mt-2 flex gap-2">
        {EVENT_EVERY.map((n) => (
          <button
            key={n}
            className={choice((plan.event_every_s ?? 0) === n, "flex-1 px-1")}
            onClick={() => onChange({ ...plan, event_every_s: n || undefined })}
          >
            {n === 0 ? no.events.wizard.off : no.events.wizard.every(n)}
          </button>
        ))}
      </div>
      <Help>{no.events.wizard.help}</Help>
      <p className="mt-5 inline-flex rounded-full bg-gold/15 px-3 py-1.5 text-sm font-extrabold text-gold-text">
        ⏱ {p.total(Math.round(planTotalS(plan) / 60))}
      </p>
    </div>
  );
}

/** 0010: own mission texts for this plan, from a pack or typed; saved as a pack on request. */
function MissionsEditor(props: {
  plan: Plan;
  onChange: (p: Plan) => void;
  packs: { id: string; name: string; items: string[] }[];
  onSavePack: (name: string, items: string[]) => Promise<boolean>;
}) {
  const m = no.missions;
  const [text, setText] = useState((props.plan.missions ?? []).join("\n"));
  const [saved, setSaved] = useState(false);
  const [naming, setNaming] = useState<string | null>(null);
  // A new plan from outside (library, start pack) replaces the text.
  const planMissions = (props.plan.missions ?? []).join("\n");
  const lastPlan = useRef(planMissions);
  useEffect(() => {
    if (planMissions !== lastPlan.current && planMissions !== text.split("\n").filter((l) => l.trim()).join("\n")) {

      setText(planMissions);
    }
    lastPlan.current = planMissions;
  }, [planMissions, text]);
  const lines = text.split("\n").filter((l) => l.trim());
  const items = lines.length ? normMissions(lines) : [];
  const set = (v: string) => {
    setText(v);
    setSaved(false);
    const ls = v.split("\n").filter((l) => l.trim());
    const { missions: _old, ...rest } = props.plan;
    void _old;
    props.onChange(ls.length ? { ...rest, missions: ls } : rest);
  };
  const btn = "ui-press min-h-12 rounded-[var(--radius-ctl)] border border-line bg-ink-2 px-3 text-sm font-bold hover:bg-ink-3 disabled:opacity-40";
  return (
    <div data-testid="missions-editor">
      <p className="text-sm leading-relaxed text-txt-dim">{m.lead}</p>
      <textarea
        className={cx(field, "mt-2 min-h-28 text-sm font-bold")}
        placeholder={m.field}
        value={text}
        onChange={(e) => set(e.target.value)}
      />
      {items === null && <p className="mt-1 text-xs font-bold text-warn-text">{m.invalid}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        {props.packs.map((p) => (
          <button key={p.id} className={btn} onClick={() => set(p.items.join("\n"))}>
            {m.fromPack}: {p.name}
          </button>
        ))}
        {items && items.length > 0 && naming === null && (
          <button className={btn} onClick={() => setNaming("")}>
            {saved ? m.saved : m.savePack}
          </button>
        )}
      </div>
      {naming !== null && (
        <form
          className="mt-2 flex flex-wrap gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (items && naming.trim() && (await props.onSavePack(naming, items))) {
              setSaved(true);
              setNaming(null);
            }
          }}
        >
          <input
            className={cx(field, "min-w-40 flex-1 text-sm font-bold")}
            placeholder={no.library.packName}
            value={naming}
            onChange={(e) => setNaming(e.target.value)}
            autoFocus
          />
          <button className={btn} disabled={!naming.trim()}>
            {no.library.save}
          </button>
          <button type="button" className={btn} onClick={() => setNaming(null)}>
            {no.common.cancel}
          </button>
        </form>
      )}
    </div>
  );
}
