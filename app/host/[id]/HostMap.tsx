"use client";

import "maplibre-gl/dist/maplibre-gl.css";

import type { GeoJSONSource, Map as MlMap, Marker } from "maplibre-gl";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

import type { FlagView, HillView, HostPlayer, PostView, RelayCourse, SessionGeo, SessionStatus, TeamScore } from "@/lib/client/api";
import { addEventLayer, addPostsLayer, addSessionLayers, addTeamLayer, addZoneLayer, boundsOf, setEvent, setPosts, setTeam, setZone } from "@/lib/map/layers";
import { TEAMS } from "@/lib/rules/teams";
import { CROWD_FROM } from "@/lib/rules/relay";
import { loadMapLibre } from "@/lib/map/maplibre";
import { kartverketStyle } from "@/lib/map/style";
import { EVENTS } from "@/lib/rules/events";
import { SAFETY } from "@/lib/rules/safety";
import { zoneAt, type ZoneState } from "@/lib/rules/zone";
import { prefersReducedMotion } from "@/lib/client/ui";

/** Name tags only from this zoom (≈ 1 px per metre at our latitudes), plus the
 * selected pupil and anyone who needs the teacher (rule 4). */
export const NAME_ZOOM = 17;
/** Dots glide between polls (the panel polls every 2 s) instead of jumping. */
const GLIDE_MS = 1900;
/** Longer jumps than this snap (rejoin, GPS recovered): no slow slide across the map. */
const GLIDE_MAX_DEG = 0.002;

type LngLat = [number, number];
type Entry = { marker: Marker; el: HTMLDivElement; from: LngLat; to: LngLat; shown: LngLat; t0: number };

export interface HostMapHandle {
  flyTo: (lat: number, lng: number) => void;
}

/** Visual state of a pupil dot, most severe first (matches the alarm strip order). */
export function dotState(p: HostPlayer, sos: boolean, status: SessionStatus) {
  if (sos) return { bg: "#ff3b30", ring: "#ffffff", pulse: true };
  if (p.forbidden || p.geofence >= 2) return { bg: "#ff3b30", ring: "#ffffff", pulse: p.geofence === 3 || p.forbidden };
  if (p.signal === "lost" || p.signal === "none") return { bg: "#6b7280", ring: "#ffffff", pulse: false };
  if (status === "gathering") return p.checked_in ? { bg: "#4fd18b", ring: "#ffffff", pulse: false } : { bg: "#ffb020", ring: "#ffffff", pulse: false };
  if (p.role === "sitting_out") return { bg: "#a78bfa", ring: "#ffffff", pulse: false };
  if (p.role === "hunter") return { bg: "#ff5a4e", ring: p.geofence === 1 ? "#ffb020" : "#ffffff", pulse: false };
  if (p.geofence === 1) return { bg: "#3d9bff", ring: "#ffb020", pulse: false };
  if (p.signal === "uncertain") return { bg: "#3d9bff", ring: "#9ca3af", pulse: false };
  return { bg: "#3d9bff", ring: "#ffffff", pulse: false };
}

const HostMap = forwardRef<
  HostMapHandle,
  {
    geo: SessionGeo;
    players: HostPlayer[];
    posts: PostView[];
    sosPlayers: Set<string>;
    status: SessionStatus;
    /** Live zone round (0005) + the server clock it runs on. */
    zone: ZoneState | null;
    serverNow: string;
    /** Sprint target of the current event (0007). */
    eventTarget?: { lat: number; lng: number } | null;
    /** 0009: teams (name tag colour — the dot keeps its safety colour, rule 4), flags, hill. */
    teams?: TeamScore[];
    teamOf?: Record<string, number>;
    flags?: FlagView[] | null;
    hill?: HillView | null;
    /** 0013: the relay course (base + posts). */
    relay?: RelayCourse | null;
    /** 0012 storskjerm: dots only — no names, not clickable. */
    anonymous?: boolean;
    /** The pupil whose card is open: always named. */
    selectedId?: string | null;
    onSelect: (id: string) => void;
  }
>(function HostMap({ geo, players, posts, sosPlayers, status, zone, serverNow, eventTarget = null, teams, teamOf, flags = null, hill = null, relay = null, anonymous = false, selectedId = null, onSelect }, ref) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const lib = useRef<Awaited<ReturnType<typeof loadMapLibre>> | null>(null);
  const markers = useRef<Map<string, Entry>>(new Map());
  const raf = useRef(0);
  const selectRef = useRef(onSelect);
  const anonymousRef = useRef(anonymous);
  const [ready, setReady] = useState(false);
  const [close, setClose] = useState(false);

  useEffect(() => {
    selectRef.current = onSelect;
  }, [onSelect]);

  useImperativeHandle(ref, () => ({
    flyTo: (lat, lng) => map.current?.flyTo({ center: [lng, lat], zoom: Math.max(map.current.getZoom(), 18), duration: 600 }),
  }));

  useEffect(() => {
    let cancelled = false;
    const owned = markers.current;
    (async () => {
      const ml = await loadMapLibre();
      if (cancelled || !container.current) return;
      lib.current = ml;
      const m = new ml.Map({
        container: container.current,
        style: kartverketStyle("topo"),
        bounds: boundsOf(geo),
        fitBoundsOptions: { padding: { top: 120, bottom: 120, left: 30, right: 30 } },
        attributionControl: { compact: true },
      });
      m.addControl(new ml.NavigationControl({ showCompass: false }), "bottom-right");
      m.on("load", () => {
        addSessionLayers(m, geo);
        addZoneLayer(m);
        addPostsLayer(m);
        addEventLayer(m);
        addTeamLayer(m);
        addCrowdLayer(m, !anonymousRef.current, (id) => selectRef.current(id));
        setClose(m.getZoom() >= NAME_ZOOM);
        setReady(true);
      });
      m.on("zoomend", () => setClose(m.getZoom() >= NAME_ZOOM));
      map.current = m;
    })();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf.current);
      owned.forEach(({ marker }) => marker.remove());
      owned.clear();
      map.current?.remove();
      map.current = null;
    };
  }, [geo]);

  // Diff markers by player id: create, move, restyle, remove.
  useEffect(() => {
    const m = map.current;
    const ml = lib.current;
    if (!ready || !m || !ml) return;
    const seen = new Set<string>();
    // 0013: a big group draws ordinary dots in one WebGL layer (clustered when
    // zoomed out); anyone who needs the teacher keeps a named marker (rule 4).
    const crowd = players.length >= CROWD_FROM;
    const dots: GeoJSON.Feature[] = [];
    let glide = false;
    for (const p of players) {
      if (!p.pos) continue;
      if (crowd) {
        const s0 = dotState(p, sosPlayers.has(p.id), status);
        const still0 = p.still_s !== null && p.still_s > SAFETY.still_alert_s && status === "live";
        const needs = s0.pulse || s0.bg === "#ff3b30" || s0.bg === "#6b7280" || still0 || (status === "gathering" && !p.checked_in);
        if (!needs) {
          dots.push({ type: "Feature", properties: { id: p.id, bg: s0.bg, ring: s0.ring, name: anonymous ? "" : p.nickname }, geometry: { type: "Point", coordinates: [p.pos.lng, p.pos.lat] } });
          continue;
        }
      }
      seen.add(p.id);
      const s = dotState(p, sosPlayers.has(p.id), status);
      const target: LngLat = [p.pos.lng, p.pos.lat];
      let entry = markers.current.get(p.id);
      if (!entry) {
        const el = document.createElement("div");
        el.className = "host-marker flex cursor-pointer flex-col items-center";
        el.innerHTML =
          '<span data-dot class="host-dot block size-5 rounded-full border-[3px]"></span>' +
          '<span data-name class="host-name"></span>';
        if (!anonymous) {
          el.addEventListener("click", (e) => {
            e.stopPropagation();
            selectRef.current(p.id);
          });
        } else el.style.cursor = "default";
        // Anchor on the dot's centre so showing/hiding the name never moves the dot.
        const marker = new ml.Marker({ element: el, anchor: "top", offset: [0, -10] }).setLngLat(target).addTo(m);
        entry = { marker, el, from: target, to: target, shown: target, t0: 0 };
        markers.current.set(p.id, entry);
      }
      if (entry.to[0] !== target[0] || entry.to[1] !== target[1]) {
        const far = Math.abs(target[0] - entry.shown[0]) > GLIDE_MAX_DEG || Math.abs(target[1] - entry.shown[1]) > GLIDE_MAX_DEG;
        // Safety (rule 4): a dot in alarm snaps to its true position, never glides.
        const snap = far || s.pulse || s.bg === "#ff3b30" || prefersReducedMotion();
        entry.from = snap ? target : entry.shown;
        entry.to = target;
        entry.t0 = performance.now();
        if (snap) {
          entry.shown = target;
          entry.marker.setLngLat(target);
        } else glide = true;
      }
      const dot = entry.el.querySelector<HTMLElement>("[data-dot]")!;
      dot.style.background = s.bg;
      dot.style.borderColor = s.ring;
      dot.classList.toggle("animate-ping-slow", s.pulse);
      const still = p.still_s !== null && p.still_s > SAFETY.still_alert_s && status === "live";
      const alarm = sosPlayers.has(p.id) || p.forbidden || p.geofence >= 2 || p.signal === "lost" || p.signal === "none";
      const named = !anonymous && (close || p.id === selectedId || alarm || still);
      const name = entry.el.querySelector<HTMLElement>("[data-name]")!;
      name.textContent = anonymous ? "" : `${p.nickname}${still ? " 💤" : ""}`;
      name.style.display = named ? "" : "none";
      const tc = teams?.find((t) => t.n === teamOf?.[p.id])?.color;
      name.style.background = tc ?? "";
      name.style.color = tc ? (tc === "#f5b800" ? "#111827" : "#ffffff") : "";
      entry.el.classList.toggle("is-selected", p.id === selectedId);
      entry.el.style.zIndex = alarm ? "3" : p.id === selectedId ? "2" : "";
      entry.el.setAttribute("aria-label", p.nickname);
    }
    for (const [id, entry] of markers.current) {
      if (!seen.has(id)) {
        entry.marker.remove();
        markers.current.delete(id);
      }
    }
    m.getSource<GeoJSONSource>("crowd")?.setData({ type: "FeatureCollection", features: dots });

    // One rAF loop for every gliding marker. We interpolate lng/lat ourselves (no
    // CSS transition on the transform), so panning/zooming never makes dots sail.
    if (glide) {
      cancelAnimationFrame(raf.current);
      const step = (now: number) => {
        let moving = false;
        for (const e of markers.current.values()) {
          if (e.shown === e.to) continue;
          const k = Math.min(1, (now - e.t0) / GLIDE_MS);
          e.shown = k >= 1 ? e.to : [e.from[0] + (e.to[0] - e.from[0]) * k, e.from[1] + (e.to[1] - e.from[1]) * k];
          e.marker.setLngLat(e.shown);
          if (k < 1) moving = true;
        }
        if (moving) raf.current = requestAnimationFrame(step);
      };
      raf.current = requestAnimationFrame(step);
    }
  }, [ready, players, sosPlayers, status, teams, teamOf, anonymous, close, selectedId]);

  // Flags / hill (0009), colour by owner / holder.
  const teamKey = (flags?.length || hill || relay) && teams?.length
    ? JSON.stringify({ c: teams.map((t) => [t.n, t.color]), flags, hill: hill ? { pos: hill.pos, r: hill.r, holder: hill.holder } : null,
        relay: relay ? { base: relay.base, r: relay.r, posts: relay.posts } : null })
    : null;
  useEffect(() => {
    if (!ready || !map.current) return;
    if (!teamKey) {
      setTeam(map.current, null);
      return;
    }
    const d = JSON.parse(teamKey) as { c: [number, string][]; flags: FlagView[] | null; hill: { pos: { lat: number; lng: number }; r: number; holder: number | null } | null;
      relay: Omit<RelayCourse, "legs"> | null };
    const colors = new Map(d.c);
    setTeam(map.current, { colorOf: (n) => (n ? colors.get(n) : undefined) ?? "#9aa3b2", flags: d.flags, flagR: TEAMS.flag_r_m, hill: d.hill, relay: d.relay });
  }, [ready, teamKey]);

  // Posts of the round: open in colour, taken in grey (teacher sees both).
  useEffect(() => {
    if (ready && map.current) setPosts(map.current, posts);
  }, [ready, posts]);

  const tLat = eventTarget?.lat ?? null;
  const tLng = eventTarget?.lng ?? null;
  useEffect(() => {
    if (ready && map.current) setEvent(map.current, tLat !== null && tLng !== null ? { lat: tLat, lng: tLng } : null, EVENTS.sprint_reach_m);
  }, [ready, tLat, tLng]);

  // Zone: a pure function of server time, redrawn each second (same circle as the phones).
  useEffect(() => {
    if (!ready || !map.current) return;
    const m = map.current;
    if (!zone) {
      setZone(m, null);
      return;
    }
    const offset = Date.parse(serverNow) - Date.now();
    const draw = () => {
      const zn = zoneAt(zone, Date.now() + offset);
      setZone(m, { c: zone.c, r: zn.r, nextR: zn.warn ? (zn.next?.r ?? null) : null });
    };
    draw();
    const iv = setInterval(draw, 1000);
    return () => clearInterval(iv);
  }, [ready, zone, serverNow]);

  return (
    <div className="host-map absolute inset-0">
      <div ref={container} className="h-full w-full" />
    </div>
  );
});

export default HostMap;

/** 0013: ordinary dots of a big group — clusters with a count when zoomed out, names close up. */
function addCrowdLayer(m: MlMap, named: boolean, onSelect: (id: string) => void) {
  m.addSource("crowd", { type: "geojson", data: { type: "FeatureCollection", features: [] }, cluster: true, clusterMaxZoom: 16, clusterRadius: 28 });
  m.addLayer({
    id: "crowd-cluster",
    type: "circle",
    source: "crowd",
    filter: ["has", "point_count"],
    paint: { "circle-color": "#3d9bff", "circle-opacity": 0.85, "circle-stroke-color": "#ffffff", "circle-stroke-width": 2,
      "circle-radius": ["step", ["get", "point_count"], 12, 10, 16, 30, 21] },
  });
  m.addLayer({
    id: "crowd-count",
    type: "symbol",
    source: "crowd",
    filter: ["has", "point_count"],
    layout: { "text-field": ["get", "point_count_abbreviated"], "text-size": 13, "text-allow-overlap": true },
    paint: { "text-color": "#ffffff" },
  });
  m.addLayer({
    id: "crowd-dot",
    type: "circle",
    source: "crowd",
    filter: ["!", ["has", "point_count"]],
    paint: { "circle-radius": 7, "circle-color": ["get", "bg"], "circle-stroke-color": ["get", "ring"], "circle-stroke-width": 2 },
  });
  if (named) {
    m.addLayer({
      id: "crowd-name",
      type: "symbol",
      source: "crowd",
      minzoom: NAME_ZOOM,
      filter: ["!", ["has", "point_count"]],
      layout: { "text-field": ["get", "name"], "text-size": 11, "text-offset": [0, 1.3] },
      paint: { "text-color": "#ffffff", "text-halo-color": "#111827", "text-halo-width": 2 },
    });
    m.on("click", "crowd-dot", (e) => {
      const id = e.features?.[0]?.properties?.id;
      if (typeof id === "string") onSelect(id);
    });
  }
  m.on("click", "crowd-cluster", (e) => {
    const f = e.features?.[0];
    if (f?.geometry.type === "Point") m.easeTo({ center: f.geometry.coordinates as [number, number], zoom: m.getZoom() + 2 });
  });
}
