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
    onSelect: (id: string) => void;
  }
>(function HostMap({ geo, players, posts, sosPlayers, status, zone, serverNow, eventTarget = null, teams, teamOf, flags = null, hill = null, relay = null, anonymous = false, onSelect }, ref) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const lib = useRef<Awaited<ReturnType<typeof loadMapLibre>> | null>(null);
  const markers = useRef<Map<string, { marker: Marker; el: HTMLDivElement }>>(new Map());
  const selectRef = useRef(onSelect);
  const anonymousRef = useRef(anonymous);
  const [ready, setReady] = useState(false);

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
        setReady(true);
      });
      map.current = m;
    })();
    return () => {
      cancelled = true;
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
      let entry = markers.current.get(p.id);
      if (!entry) {
        const el = document.createElement("div");
        el.className = "flex cursor-pointer flex-col items-center";
        el.innerHTML =
          '<span data-dot class="block size-5 rounded-full border-[3px] shadow-lg"></span>' +
          '<span data-name class="mt-0.5 rounded bg-black/70 px-1 text-[11px] font-bold leading-tight text-white"></span>';
        if (!anonymous) {
          el.addEventListener("click", (e) => {
            e.stopPropagation();
            selectRef.current(p.id);
          });
        } else el.style.cursor = "default";
        const marker = new ml.Marker({ element: el, anchor: "top" }).setLngLat([p.pos.lng, p.pos.lat]).addTo(m);
        entry = { marker, el };
        markers.current.set(p.id, entry);
      }
      entry.marker.setLngLat([p.pos.lng, p.pos.lat]);
      const s = dotState(p, sosPlayers.has(p.id), status);
      const dot = entry.el.querySelector<HTMLElement>("[data-dot]")!;
      dot.style.background = s.bg;
      dot.style.borderColor = s.ring;
      dot.classList.toggle("animate-ping-slow", s.pulse);
      const still = p.still_s !== null && p.still_s > SAFETY.still_alert_s && status === "live";
      const name = entry.el.querySelector<HTMLElement>("[data-name]")!;
      name.textContent = anonymous ? "" : `${p.nickname}${still ? " 💤" : ""}`;
      name.style.display = anonymous ? "none" : "";
      const tc = teams?.find((t) => t.n === teamOf?.[p.id])?.color;
      name.style.background = tc ?? "";
      name.style.color = tc === "#f5b800" ? "#111827" : "";
      entry.el.setAttribute("aria-label", p.nickname);
    }
    for (const [id, entry] of markers.current) {
      if (!seen.has(id)) {
        entry.marker.remove();
        markers.current.delete(id);
      }
    }
    m.getSource<GeoJSONSource>("crowd")?.setData({ type: "FeatureCollection", features: dots });
  }, [ready, players, sosPlayers, status, teams, teamOf, anonymous]);

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
    <div className="absolute inset-0">
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
      minzoom: 18,
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
