"use client";

import "maplibre-gl/dist/maplibre-gl.css";

import type { GeoJSONSource, GeolocateControl, Map as MlMap, Marker } from "maplibre-gl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiError, api, type LibArea, type LibPlan, type Library } from "@/lib/client/api";
import { Button, Chip, cx } from "@/lib/client/ui";
import {
  IconAlert,
  IconBan,
  IconBook,
  IconCheck,
  IconChevronDown,
  IconCircle,
  IconFlag,
  IconLocate,
  IconPencil,
  IconPlus,
  IconRepeat,
  IconUndo,
  IconX,
} from "@/lib/client/ui/icons";
import { planSummary } from "@/lib/client/planSummary";
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
import { DEFAULT_PLAN, planTotalS, type Plan } from "@/lib/rules/game";
import type { StarterPack } from "@/lib/starter";
import { loadMapLibre } from "@/lib/map/maplibre";
import { DEFAULT_CENTER, kartverketStyle } from "@/lib/map/style";

import { FLAG_SVG } from "./icons";
import { Note, SheetFooter, card, field, segment } from "./parts";
import { RoundsStep } from "./RoundsStep";

const t = no.wizard;

type Step = "start" | "area" | "rounds" | "ready";
type AreaMode = "circle" | "draw";
type DrawTarget = "area" | "forbidden" | null;

const STEPS: Step[] = ["area", "rounds", "ready"];
const ORDER: Step[] = ["start", ...STEPS];
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

/** Default assembly point: inside the area and ≥ 30 m from every blocked area if possible. */
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

const hasContent = (lib: Library | null) => !!lib && (lib.areas.length > 0 || lib.plans.length > 0);

/**
 * Teacher onboarding (PLAN §2.1) in three steps: Område (area, møteplass and
 * sperrede områder on the map) then Runder (opplegg + extras) then Klar (safety)
 * then create then lobby. A start screen («Samme som sist» / «Ny økt») comes first
 * only when the library has something. The drawing tool is our own: tap to add
 * a corner, drag a corner marker to move it (native MapLibre draggable markers).
 */
export default function Wizard() {
  const router = useRouter();
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const ml = useRef<Awaited<ReturnType<typeof loadMapLibre>> | null>(null);
  const geoCtl = useRef<GeolocateControl | null>(null);
  const vertexMarkers = useRef<Marker[]>([]);
  const assemblyMarker = useRef<Marker | null>(null);
  const centreMarker = useRef<Marker | null>(null);
  const sheetEl = useRef<HTMLDivElement | null>(null);
  /** The teacher (or a saved area) placed the møteplass: stop auto-placing it. */
  const assemblyPinned = useRef(false);
  /** The area was adjusted: an opplegg no longer resizes the circle. */
  const areaTouched = useRef(false);

  const [ready, setReady] = useState(false);
  const [booted, setBooted] = useState(false);
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
  const [checks, setChecks] = useState<boolean[]>(t.ready.checks.map(() => false));
  // 0010: the teacher's library («Samme som sist», mission and quiz packs).
  const [library, setLibrary] = useState<Library | null>(null);
  const [quizValid, setQuizValid] = useState(true);
  const wanted = useRef<{ area: string | null; plan: string | null } | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // Presentation only: slide direction, folded map sheet.
  const [dir, setDir] = useState<"next" | "back">("next");
  const [collapsed, setCollapsed] = useState(false);

  // The lærernøkkel is made silently (it is shown in the library). The start
  // screen appears only when the library has something; /ny?area=…&plan=…
  // (from the library or a share copy) goes straight to the area.
  useEffect(() => {
    const { key } = identity.ensureTeacherKey();
    identity.markIntroSeen();
    const q = new URLSearchParams(window.location.search);
    const area = q.get("area");
    const plan = q.get("plan");
    const fromLink = !!(area || plan);
    if (fromLink) wanted.current = { area, plan };
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reading localStorage after mount
    setTeacherKey(key);
    if (fromLink) setBooted(true);
    api.library
      .get(key)
      .then((lib) => {
        setLibrary(lib);
        if (!fromLink && hasContent(lib)) setStep("start");
      })
      .catch(() => setLibrary(null))
      .finally(() => setBooted(true));
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

  // Møteplass follows the area until the teacher drags it.
  useEffect(() => {
    if (!areaRing || assemblyPinned.current) return;
     
    setAssembly(defaultAssembly(areaRing, forbidden));
  }, [areaRing, forbidden]);

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
      geoCtl.current = geo;
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
      centreMarker.current?.remove();
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
      el.setAttribute("aria-label", t.area.corner(i + 1));
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

  // Møteplass marker: draggable in the area step, shown again on «Klar».
  const assemblyDrag = step === "area" && !drawTarget;
  useEffect(() => {
    const m = map.current;
    const lib = ml.current;
    if (!ready || !m || !lib) return;
    const show = assembly && (step === "area" || step === "ready");
    if (!show) {
      assemblyMarker.current?.remove();
      assemblyMarker.current = null;
      return;
    }
    if (!assemblyMarker.current) {
      const el = document.createElement("div");
      el.className = "grid size-12 cursor-grab place-items-center rounded-full border-[3px] border-white bg-ok text-white shadow-xl";
      el.innerHTML = FLAG_SVG;
      el.setAttribute("aria-label", t.assembly.label);
      const mk = new lib.Marker({ element: el, draggable: assemblyDrag }).setLngLat([assembly[0], assembly[1]]).addTo(m);
      mk.on("dragend", () => {
        const ll = mk.getLngLat();
        assemblyPinned.current = true;
        setAssembly([ll.lng, ll.lat]);
      });
      assemblyMarker.current = mk;
    } else {
      assemblyMarker.current.setLngLat([assembly[0], assembly[1]]);
      assemblyMarker.current.setDraggable(assemblyDrag);
    }
  }, [ready, assembly, step, assemblyDrag]);

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
        // The sheet's footprint is already map padding (see below); this is just breathing room.
        padding: 36,
        maxZoom: 18,
        duration: 500,
      },
    );
  }, [areaRing]);

  const fitRef = useRef(fitArea);
  useEffect(() => {
    fitRef.current = fitArea;
  }, [fitArea]);
  const refitOnResize = useRef(false);
  useEffect(() => {
    refitOnResize.current = step === "area" && !drawTarget;
  }, [step, drawTarget]);

  // The sheet covers part of the map (bottom on phones, left on wide screens).
  // Tell the map, so «centre» means the centre of what the teacher can see:
  // GPS lock, fitBounds and the circle all land in the visible part.
  useEffect(() => {
    const m = map.current;
    const el = sheetEl.current;
    if (!ready || !booted || !m || !el) return;
    const apply = () => {
      // Layout sizes, not getBoundingClientRect() of the sheet: its slide-in
      // animation is a transform, which would make the footprint look smaller.
      const parent = el.parentElement;
      if (!parent) return;
      const pr = parent.getBoundingClientRect();
      const cs = getComputedStyle(parent);
      const wide = window.matchMedia("(min-width: 1024px)").matches;
      const padding = wide
        ? { top: 0, bottom: 0, right: 0, left: Math.round(pr.left + parseFloat(cs.paddingLeft) + el.offsetWidth) }
        : {
            top: 84,
            left: 0,
            right: 0,
            bottom: Math.max(0, Math.round(window.innerHeight - pr.bottom + parseFloat(cs.paddingBottom) + el.offsetHeight)),
          };
      // In the area step a padding change re-fits the area, so a growing sheet
      // never leaves the circle hidden behind it.
      if (refitOnResize.current) {
        m.setPadding(padding);
        fitRef.current();
      } else m.easeTo({ padding, duration: 250 });
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    window.addEventListener("resize", apply);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", apply);
    };
  }, [ready, booted]);

  // Circle mode: move the circle by tapping the map or dragging its handle.
  const circleEdit = ready && step === "area" && areaMode === "circle" && !drawTarget;
  useEffect(() => {
    const m = map.current;
    const lib = ml.current;
    if (!circleEdit || !m || !lib) return;
    const onClick = (e: { lngLat: { lng: number; lat: number } }) => {
      areaTouched.current = true;
      setCircleCentre([e.lngLat.lng, e.lngLat.lat]);
    };
    m.on("click", onClick);
    return () => {
      m.off("click", onClick);
    };
  }, [circleEdit]);
  useEffect(() => {
    const m = map.current;
    const lib = ml.current;
    if (!circleEdit || !circleCentre || !m || !lib) {
      centreMarker.current?.remove();
      centreMarker.current = null;
      return;
    }
    if (!centreMarker.current) {
      const el = document.createElement("div");
      el.className = "t-centre-handle";
      el.setAttribute("aria-label", t.area.handle);
      const mk = new lib.Marker({ element: el, draggable: true }).setLngLat([circleCentre[0], circleCentre[1]]).addTo(m);
      mk.on("drag", () => {
        const ll = mk.getLngLat();
        areaTouched.current = true;
        setCircleCentre([ll.lng, ll.lat]);
      });
      centreMarker.current = mk;
    } else {
      centreMarker.current.setLngLat([circleCentre[0], circleCentre[1]]);
    }
  }, [circleEdit, circleCentre]);

  // Keep the whole circle in view when it first appears and when its size changes
  // (not while it is being moved: the teacher put it where they want it).
  const hasCentre = !!circleCentre;
  useEffect(() => {
    if (!ready || step !== "area" || areaMode !== "circle" || !hasCentre) return;
    const id = setTimeout(() => fitRef.current(), 60);
    return () => clearTimeout(id);
  }, [ready, step, areaMode, hasCentre, radius]);

  // ── drawing actions ──
  function startDraw(target: Exclude<DrawTarget, null>) {
    setDraft([]);
    setDraftError(null);
    setDrawTarget(target);
    setCollapsed(false);
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
      areaTouched.current = true;
      setDrawnArea(draft);
    } else if (drawTarget === "forbidden") {
      const c = ringCenter(draft);
      if (areaRing && signedDistanceToRing(c, areaRing) > ASSEMBLY_MAX_M) return setDraftError(t.blocked.outside);
      setForbidden((f) => [...f, draft]);
    }
    cancelDraw();
  }
  function findMe() {
    if (!me) {
      geoCtl.current?.trigger();
      return;
    }
    if (areaMode === "circle") {
      areaTouched.current = true;
      setCircleCentre(me);
      setTimeout(() => fitRef.current(), 0);
    } else {
      map.current?.easeTo({ center: [me[0], me[1]], duration: 400 });
    }
  }

  // ── step navigation ──
  function goTo(next: Step) {
    // The rounds step remounts its editors from the plan, which is always parseable.
    if (step === "rounds") setQuizValid(true);
    setDir(ORDER.indexOf(next) < ORDER.indexOf(step) ? "back" : "next");
    setCollapsed(false);
    setStep(next);
    sheetEl.current?.scrollTo({ top: 0 });
    if (next !== "start") setTimeout(fitArea, 0);
  }

  // ── 0010: library / opplegg ──
  function applyArea(a: LibArea) {
    const ring = a.boundary.coordinates[0].map((p) => [p[0], p[1]] as LngLat);
    areaTouched.current = true;
    assemblyPinned.current = true;
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
    if (areaTouched.current || areaMode !== "circle") return;
    setRadius(pack.radius_m);
  }
  const lastArea = library?.areas.reduce<LibArea | null>((b, a) => (!b || a.last_used_at > b.last_used_at ? a : b), null) ?? null;
  const lastPlan = library?.plans.reduce<LibPlan | null>((b, a) => (!b || a.last_used_at > b.last_used_at ? a : b), null) ?? null;
  const showStart = hasContent(library);

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

  async function savePack(kind: "pack" | "quiz", name: string, items: unknown) {
    if (!teacherKey) return false;
    try {
      await api.library.save(teacherKey, kind, name, { items });
      setLibrary(await api.library.get(teacherKey));
      return true;
    } catch {
      return false;
    }
  }

  // ── UI ──
  const onMap = step === "area";
  const isCollapsed = onMap && collapsed && !drawTarget;
  const stepCls = dir === "back" ? "t-step-back" : "t-step-next";
  const allChecked = checks.every(Boolean);
  const idx = STEPS.indexOf(step);
  const areaNextBlocked = areaBlocked || !assembly || assemblyFar || assemblyForbidden;

  const head = (title: string) => (
    <div className="flex items-start gap-3">
      <h2 className="min-w-0 flex-1 pt-2.5 text-xl leading-snug font-black">{title}</h2>
      {!drawTarget && (
        <button
          type="button"
          className="ui-press -mt-1 -mr-2 grid size-12 flex-none place-items-center rounded-full text-txt-dim hover:bg-ink-3 hover:text-txt"
          aria-expanded={!collapsed}
          aria-label={collapsed ? t.sheetShow : t.sheetHide}
          onClick={() => setCollapsed((c) => !c)}
        >
          <IconChevronDown className="t-chevron rotate-180" />
        </button>
      )}
    </div>
  );

  return (
    <div className="relative h-dvh w-full overflow-hidden">
      <div className="absolute inset-0">
        <div ref={container} className="h-full w-full" />
      </div>

      {/* top: close + steps */}
      {booted && (
        <div className="pointer-events-none absolute inset-x-0 top-0 p-3 pt-[max(0.75rem,env(safe-area-inset-top))] lg:right-auto lg:w-[28rem]">
          <div className="m-drop-in pointer-events-auto mr-14 flex items-center gap-2 rounded-full bg-ink-2/95 py-1 pr-5 pl-1 shadow-[var(--shadow-float)] backdrop-blur lg:mr-0">
            <Link
              href="/"
              className="ui-press grid size-12 flex-none place-items-center rounded-full text-txt-dim hover:bg-ink-3 hover:text-txt"
              aria-label={t.close}
            >
              <IconX />
            </Link>
            {idx >= 0 && (
              <ol className="flex min-w-0 flex-1 items-center justify-center gap-2 text-sm font-bold whitespace-nowrap" aria-label={t.title}>
                {STEPS.map((s, i) => (
                  <li key={s} className="flex items-center gap-2" aria-current={i === idx ? "step" : undefined}>
                    {i > 0 && <span className="size-1 rounded-full bg-line" aria-hidden />}
                    <span className={cx(i === idx ? "text-gold-text" : i < idx ? "text-txt" : "text-txt-dim")}>{t.steps[i]}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:inset-y-0 lg:right-auto lg:flex lg:w-[28rem] lg:flex-col lg:justify-end lg:pt-24">
        {booted && (
          <div
            ref={sheetEl}
            className={cx(
              "m-sheet-in pointer-events-auto mx-auto w-full max-w-md overflow-y-auto overscroll-contain rounded-[1.75rem] bg-ink-2 shadow-[var(--shadow-float)] transition-[max-height] duration-[var(--dur-3)] ease-[var(--ease-out)] lg:max-w-none",
              onMap ? "max-h-[55dvh] lg:max-h-full" : "max-h-[82dvh] lg:max-h-full",
            )}
          >
            <div key={step} className={cx("p-6", stepCls)} data-testid={step === "start" ? "start-step" : undefined}>
              {step === "start" && (
                <>
                  <h1 className="text-2xl font-black">{no.start.title}</h1>
                  <div className="m-stagger mt-6 grid gap-3">
                    {(lastArea || lastPlan) && (
                      <button
                        className={card(true, "min-h-28 justify-center")}
                        onClick={() => {
                          if (lastArea) applyArea(lastArea);
                          if (lastPlan) applyPlan(lastPlan);
                          goTo(lastArea && lastPlan ? "ready" : lastArea ? "rounds" : "area");
                        }}
                        data-testid="start-reuse"
                        style={{ "--i": 0 } as React.CSSProperties}
                      >
                        <span className="flex items-center gap-3 text-lg font-black">
                          <IconRepeat className="text-gold-text" />
                          {no.start.reuse}
                        </span>
                        <span className="mt-1 block w-full truncate pl-8 text-sm text-txt-dim">
                          {no.start.reuseHint(lastArea?.name ?? "", lastPlan ? planSummary(lastPlan.plan).modes : "")}
                        </span>
                      </button>
                    )}
                    <button
                      className={card(false, "min-h-28 justify-center")}
                      onClick={() => goTo("area")}
                      data-testid="start-fresh"
                      style={{ "--i": 1 } as React.CSSProperties}
                    >
                      <span className="flex items-center gap-3 text-lg font-black">
                        <IconPlus className="text-gold-text" />
                        {no.start.fresh}
                      </span>
                      <span className="mt-1 block pl-8 text-sm text-txt-dim">{no.start.freshHint}</span>
                    </button>
                  </div>
                  <Link
                    href="/bibliotek"
                    className="mt-4 inline-flex min-h-12 items-center gap-2 text-sm font-bold text-txt-dim hover:text-txt"
                  >
                    <IconBook size={18} />
                    {no.start.library}
                  </Link>
                </>
              )}

              {step === "area" && (
                <>
                  {head(drawTarget === "forbidden" ? t.blocked.drawing : t.area.lead)}
                  {drawTarget === "forbidden" ? (
                    <DrawControls
                      tone="forbidden"
                      count={draft.length}
                      error={draftError}
                      onUndo={() => setDraft((d) => d.slice(0, -1))}
                      onClear={() => setDraft([])}
                      onFinish={finishDraw}
                      onCancel={cancelDraw}
                    />
                  ) : (
                    !isCollapsed && (
                      <div className="m-fade-in">
                        {!drawTarget && (
                          <div className="mt-5 flex gap-1 rounded-[var(--radius-ctl)] bg-ink p-1" role="group">
                            <button className={segment(areaMode === "circle")} aria-pressed={areaMode === "circle"} onClick={() => setAreaMode("circle")}>
                              <IconCircle size={18} />
                              {t.area.circle}
                            </button>
                            <button
                              className={segment(areaMode === "draw")}
                              aria-pressed={areaMode === "draw"}
                              onClick={() => {
                                setAreaMode("draw");
                                if (!drawnArea) startDraw("area");
                              }}
                            >
                              <IconPencil size={18} />
                              {t.area.draw}
                            </button>
                          </div>
                        )}

                        {areaMode === "circle" && (
                          <>
                            {gpsState === "locating" && !circleCentre && <p className="mt-4 text-sm text-txt-dim">{t.area.locating}</p>}
                            {gpsState === "error" && <Note tone="warn">{t.area.noGps}</Note>}
                            <label className="mt-5 block">
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
                                onChange={(e) => {
                                  areaTouched.current = true;
                                  setRadius(Number(e.target.value));
                                }}
                                className="mt-1 h-12 w-full cursor-pointer accent-gold"
                              />
                            </label>
                          </>
                        )}

                        {areaMode === "draw" && drawTarget === "area" && (
                          <DrawControls
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
                          />
                        )}
                        {areaMode === "draw" && drawnArea && !drawTarget && (
                          <div className="mt-4 flex items-center justify-between gap-3 rounded-2xl bg-ink py-1 pr-1 pl-4">
                            <span className="text-sm font-semibold text-txt-dim">{no.map.area(areaM2)}</span>
                            <Button variant="ghost" className="gap-2 text-sm" onClick={() => startDraw("area")}>
                              <IconPencil size={18} />
                              {t.area.redraw}
                            </Button>
                          </div>
                        )}

                        {!drawTarget && (
                          <>
                            <p className="mt-4 flex items-start gap-2 text-sm leading-snug text-txt-dim">
                              <IconFlag size={18} className="mt-px flex-none text-ok-text" />
                              <span>
                                {areaMode === "circle" ? `${t.area.circleHint} ` : ""}
                                {t.area.assemblyHint}
                              </span>
                            </p>

                            <div className="mt-5 flex flex-wrap items-center gap-2">
                              <Button variant="secondary" size="sm" className="min-h-12 gap-2" onClick={findMe}>
                                <IconLocate size={18} />
                                {t.area.findMe}
                              </Button>
                              {forbidden.map((r, i) => (
                                <span
                                  key={i}
                                  className="m-rise-in inline-flex min-h-12 items-center gap-2 rounded-full bg-danger/10 pr-1 pl-3.5 text-sm font-bold text-danger-text"
                                  title={no.map.area(ringArea(r))}
                                >
                                  <IconBan size={16} />
                                  {t.blocked.zone(i + 1)}
                                  <button
                                    type="button"
                                    className="ui-press grid size-10 place-items-center rounded-full hover:bg-danger/15"
                                    aria-label={t.blocked.remove(i + 1)}
                                    onClick={() => setForbidden((f) => f.filter((_, j) => j !== i))}
                                  >
                                    <IconX size={16} />
                                  </button>
                                </span>
                              ))}
                              <Button variant="ghost" size="sm" className="min-h-12 gap-2" onClick={() => startDraw("forbidden")} data-testid="add-blocked">
                                <IconBan size={18} />
                                {t.blocked.add}
                              </Button>
                            </div>
                          </>
                        )}

                        {areaWarning && !drawTarget && <Note tone="warn">{areaWarning}</Note>}
                        {assemblyFar && !drawTarget && <Note tone="danger">{t.assembly.far}</Note>}
                        {assemblyForbidden && !drawTarget && <Note tone="danger">{t.assembly.inBlocked}</Note>}
                      </div>
                    )
                  )}
                  {!drawTarget && (
                    <SheetFooter plain={isCollapsed}>
                      {showStart ? (
                        <Button variant="ghost" onClick={() => goTo("start")}>
                          {t.back}
                        </Button>
                      ) : (
                        <span />
                      )}
                      <Button size="lg" className="min-w-32" disabled={areaNextBlocked} onClick={() => goTo("rounds")}>
                        {t.next}
                      </Button>
                    </SheetFooter>
                  )}
                </>
              )}

              {step === "rounds" && (
                <RoundsStep
                  plan={plan}
                  onChange={setPlan}
                  onStarter={applyStarter}
                  quizValid={quizValid}
                  onQuizValid={setQuizValid}
                  missionPacks={library?.packs ?? []}
                  quizPacks={library?.quizzes ?? []}
                  onSave={savePack}
                  onBack={() => goTo("area")}
                  onNext={() => goTo("ready")}
                />
              )}

              {step === "ready" && (
                <>
                  <h2 className="text-xl font-black">{t.ready.lead}</h2>

                  <dl className="mt-5 grid grid-cols-3 gap-2 text-center" data-testid="ready-summary">
                    {[
                      [t.ready.area, no.map.area(areaM2)],
                      [t.ready.rounds, t.ready.roundsN(plan.rounds.length)],
                      [t.ready.time, t.playlist.total(Math.round(planTotalS(plan) / 60))],
                    ].map(([k, v]) => (
                      <div key={k} className="rounded-2xl bg-ink px-2 py-3">
                        <dt className="text-xs font-bold text-txt-dim">{k}</dt>
                        <dd className="mt-0.5 truncate text-sm font-black">{v}</dd>
                      </div>
                    ))}
                  </dl>
                  {forbidden.length > 0 && <p className="mt-2 text-center text-xs font-bold text-txt-dim">{t.ready.blockedN(forbidden.length)}</p>}

                  <div className="mt-6 space-y-2" role="group" aria-label={t.ready.lead}>
                    {t.ready.checks.map((label, i) => (
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

                  <p className="mt-4 flex items-start gap-2.5 text-sm leading-relaxed font-semibold text-warn-text" role="note">
                    <IconAlert size={18} className="mt-0.5 flex-none" />
                    <span>{t.ready.traffic}</span>
                  </p>

                  <label className="mt-6 block">
                    <span className="text-sm font-bold">{t.ready.phone}</span>
                    <input
                      type="tel"
                      inputMode="tel"
                      autoComplete="tel"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="912 34 567"
                      className={cx(field, "mt-2 text-lg")}
                    />
                    <span className="mt-2 block text-xs leading-relaxed text-txt-dim">{t.ready.phoneHint}</span>
                  </label>

                  {!allChecked && <p className="mt-5 text-sm text-txt-dim">{t.ready.checkAll}</p>}
                  {createError && (
                    <Note tone="danger" alert>
                      {createError}
                    </Note>
                  )}
                  <SheetFooter>
                    <Button variant="ghost" onClick={() => goTo("rounds")} disabled={creating}>
                      {t.back}
                    </Button>
                    <Button size="lg" className="min-w-0 flex-1 sm:flex-none" disabled={!allChecked || creating} onClick={create} data-testid="create">
                      {creating ? t.ready.creating : t.ready.create}
                    </Button>
                  </SheetFooter>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function DrawControls(props: {
  tone: "area" | "forbidden";
  count: number;
  error: string | null;
  onUndo: () => void;
  onClear: () => void;
  onFinish: () => void;
  onCancel: () => void;
}) {
  const btn = "flex-1 gap-2 px-3 text-sm";
  return (
    <div className="m-fade-in mt-4">
      <p className="flex items-center gap-2 text-sm leading-relaxed text-txt-dim">
        <span className={cx("size-2.5 flex-none rounded-full", props.tone === "area" ? "bg-gold" : "bg-danger")} aria-hidden />
        <span className="flex-1">{t.area.drawHint}</span>
        <Chip tone={props.count >= 3 ? "ok" : "neutral"}>{t.area.corners(props.count)}</Chip>
      </p>
      {props.error && <Note tone="danger">{props.error}</Note>}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="secondary" className={btn} disabled={props.count === 0} onClick={props.onUndo}>
          <IconUndo size={18} />
          {t.area.undo}
        </Button>
        <Button variant="secondary" className={btn} disabled={props.count === 0} onClick={props.onClear}>
          {t.area.clear}
        </Button>
        <Button variant="ghost" className={btn} onClick={props.onCancel}>
          {no.common.cancel}
        </Button>
        <Button className={cx(btn, "min-w-24")} disabled={props.count < 3} onClick={props.onFinish}>
          <IconCheck size={18} />
          {t.area.finish}
        </Button>
      </div>
    </div>
  );
}
