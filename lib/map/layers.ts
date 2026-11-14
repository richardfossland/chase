import type { GeoJSONSource, Map as MlMap } from "maplibre-gl";
import type { Feature } from "geojson";

import type { SessionGeo } from "@/lib/client/api";

// Shared session layers (area, forbidden zones, assembly point) for the player
// view and the teacher panel.

const EMPTY = { type: "FeatureCollection" as const, features: [] };

export function addSessionLayers(m: MlMap, geo: SessionGeo) {
  m.addSource("area", { type: "geojson", data: { type: "Feature", properties: {}, geometry: geo.boundary } });
  m.addLayer({ id: "area-fill", type: "fill", source: "area", paint: { "fill-color": "#ebb84b", "fill-opacity": 0.08 } });
  m.addLayer({ id: "area-line", type: "line", source: "area", paint: { "line-color": "#ebb84b", "line-width": 3 } });
  m.addSource("forbidden", {
    type: "geojson",
    data: geo.forbidden ? { type: "Feature", properties: {}, geometry: geo.forbidden } : EMPTY,
  });
  m.addLayer({ id: "forbidden-fill", type: "fill", source: "forbidden", paint: { "fill-color": "#ff3b30", "fill-opacity": 0.35 } });
  m.addLayer({ id: "forbidden-line", type: "line", source: "forbidden", paint: { "line-color": "#ff3b30", "line-width": 2 } });
  m.addSource("assembly", {
    type: "geojson",
    data: { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [geo.assembly.lng, geo.assembly.lat] } },
  });
  m.addLayer({
    id: "assembly",
    type: "circle",
    source: "assembly",
    paint: { "circle-radius": 9, "circle-color": "#4fd18b", "circle-stroke-color": "#ffffff", "circle-stroke-width": 3 },
  });
}

/** A single "me" dot with an accuracy halo. */
export function addMeLayer(m: MlMap) {
  m.addSource("me", { type: "geojson", data: EMPTY });
  m.addLayer({
    id: "me-dot",
    type: "circle",
    source: "me",
    paint: { "circle-radius": 8, "circle-color": "#3d9bff", "circle-stroke-color": "#ffffff", "circle-stroke-width": 3 },
  });
}

export function setMe(m: MlMap, lng: number, lat: number) {
  m.getSource<GeoJSONSource>("me")?.setData({
    type: "Feature",
    properties: {},
    geometry: { type: "Point", coordinates: [lng, lat] },
  });
}

export function boundsOf(geo: SessionGeo): [[number, number], [number, number]] {
  const ring = geo.boundary.coordinates[0];
  const lngs = ring.map((p) => p[0]);
  const lats = ring.map((p) => p[1]);
  return [
    [Math.min(...lngs), Math.min(...lats)],
    [Math.max(...lngs), Math.max(...lats)],
  ];
}

/** Postjakt posts (PLAN §3.1). Colour/size by value; the post being claimed gets a white ring. */
export function addPostsLayer(m: MlMap, beforeId?: string) {
  m.addSource("posts", { type: "geojson", data: EMPTY });
  m.addLayer(
    {
      id: "posts-halo",
      type: "circle",
      source: "posts",
      filter: ["==", ["get", "kind"], "golden"],
      paint: { "circle-radius": 22, "circle-color": "#ffd23f", "circle-opacity": 0.35, "circle-blur": 0.4 },
    },
    beforeId,
  );
  m.addLayer(
    {
      id: "posts-dot",
      type: "circle",
      source: "posts",
      paint: {
        "circle-radius": ["case", ["==", ["get", "kind"], "golden"], 13, [">=", ["get", "value"], 20], 11, 9],
        "circle-color": [
          "case",
          ["==", ["get", "kind"], "golden"], "#ffd23f",
          ["to-boolean", ["get", "claimed"]], "#6b7280",
          [">=", ["get", "value"], 20], "#ff8a3d",
          "#ebb84b",
        ],
        "circle-stroke-color": ["case", ["to-boolean", ["get", "active"]], "#ffffff", "#1b1f2a"],
        "circle-stroke-width": ["case", ["to-boolean", ["get", "active"]], 5, 2],
      },
    },
    beforeId,
  );
}

export function setPosts(
  m: MlMap,
  posts: { id: string; pos: { lat: number; lng: number }; value: number; kind: string; claimed_by?: string | null }[],
  activeId?: string | null,
) {
  m.getSource<GeoJSONSource>("posts")?.setData({
    type: "FeatureCollection",
    features: posts.map((p) => ({
      type: "Feature",
      properties: { id: p.id, value: p.value, kind: p.kind, active: p.id === activeId, claimed: !!p.claimed_by },
      geometry: { type: "Point", coordinates: [p.pos.lng, p.pos.lat] },
    })),
  });
}

/** Smittejakt radar for hunters: last pinged prey positions, fading with age. */
export function addRadarLayer(m: MlMap) {
  m.addSource("radar", { type: "geojson", data: EMPTY });
  m.addLayer({
    id: "radar-ring",
    type: "circle",
    source: "radar",
    paint: {
      "circle-radius": 16,
      "circle-color": "#3d9bff",
      "circle-opacity": ["interpolate", ["linear"], ["get", "age"], 0, 0.35, 30, 0.05],
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 1,
      "circle-stroke-opacity": ["interpolate", ["linear"], ["get", "age"], 0, 0.9, 30, 0.2],
    },
  });
  m.addLayer({
    id: "radar-dot",
    type: "circle",
    source: "radar",
    paint: {
      "circle-radius": 6,
      "circle-color": "#3d9bff",
      "circle-opacity": ["interpolate", ["linear"], ["get", "age"], 0, 1, 30, 0.3],
    },
  });
}

export function setRadar(m: MlMap, pings: { pos: { lat: number; lng: number }; age_s: number }[]) {
  m.getSource<GeoJSONSource>("radar")?.setData({
    type: "FeatureCollection",
    features: pings.map((p) => ({
      type: "Feature",
      properties: { age: p.age_s },
      geometry: { type: "Point", coordinates: [p.pos.lng, p.pos.lat] },
    })),
  });
}

/** A circle as a 64-gon ring (lng/lat), local flat-earth — fine at school-yard scale. */
export function circleRing(c: { lat: number; lng: number }, rM: number, n = 64): [number, number][] {
  const dLat = rM / 111320;
  const dLng = rM / (111320 * Math.cos((c.lat * Math.PI) / 180));
  const ring: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * 2 * Math.PI;
    ring.push([c.lng + dLng * Math.sin(a), c.lat + dLat * Math.cos(a)]);
  }
  return ring;
}

/** Krympende sone: everything outside the circle is tinted red, the next circle dashed. */
export function addZoneLayer(m: MlMap) {
  m.addSource("zone", { type: "geojson", data: EMPTY });
  // Under the forbidden zones and the assembly point: safety stays on top (CLAUDE.md rule 4).
  const before = m.getLayer("forbidden-fill") ? "forbidden-fill" : undefined;
  m.addLayer({
    id: "zone-outside",
    type: "fill",
    source: "zone",
    filter: ["==", ["get", "kind"], "outside"],
    paint: { "fill-color": "#ff3b30", "fill-opacity": 0.22 },
  }, before);
  m.addLayer({
    id: "zone-line",
    type: "line",
    source: "zone",
    filter: ["==", ["get", "kind"], "now"],
    paint: { "line-color": "#ff3b30", "line-width": 4 },
  }, before);
  m.addLayer({
    id: "zone-next",
    type: "line",
    source: "zone",
    filter: ["==", ["get", "kind"], "next"],
    paint: { "line-color": "#ffffff", "line-width": 3, "line-dasharray": [2, 2] },
  }, before);
}

export function setZone(m: MlMap, z: { c: { lat: number; lng: number }; r: number; nextR: number | null } | null) {
  const src = m.getSource<GeoJSONSource>("zone");
  if (!src) return;
  if (!z) {
    src.setData(EMPTY);
    return;
  }
  const ring = circleRing(z.c, z.r);
  // World-ish box with the circle as a hole (reverse winding for the hole).
  const box: [number, number][] = [
    [z.c.lng - 1, z.c.lat - 1], [z.c.lng + 1, z.c.lat - 1], [z.c.lng + 1, z.c.lat + 1], [z.c.lng - 1, z.c.lat + 1], [z.c.lng - 1, z.c.lat - 1],
  ];
  const features: Feature[] = [
    { type: "Feature", properties: { kind: "outside" }, geometry: { type: "Polygon", coordinates: [box, [...ring].reverse()] } },
    { type: "Feature", properties: { kind: "now" }, geometry: { type: "LineString", coordinates: ring } },
  ];
  if (z.nextR !== null) {
    features.push({ type: "Feature", properties: { kind: "next" }, geometry: { type: "LineString", coordinates: circleRing(z.c, z.nextR) } });
  }
  src.setData({ type: "FeatureCollection", features });
}

/** Event target (0007): the sprint point as a gold ring of its reach radius + a dot. */
export function addEventLayer(m: MlMap) {
  m.addSource("event", { type: "geojson", data: EMPTY });
  m.addLayer({
    id: "event-reach",
    type: "fill",
    source: "event",
    filter: ["==", ["get", "kind"], "reach"],
    paint: { "fill-color": "#ffc83d", "fill-opacity": 0.3 },
  });
  m.addLayer({
    id: "event-ring",
    type: "line",
    source: "event",
    filter: ["==", ["get", "kind"], "reach"],
    paint: { "line-color": "#ffc83d", "line-width": 3 },
  });
  m.addLayer({
    id: "event-dot",
    type: "circle",
    source: "event",
    filter: ["==", ["get", "kind"], "dot"],
    paint: { "circle-radius": 9, "circle-color": "#ffc83d", "circle-stroke-color": "#111827", "circle-stroke-width": 3 },
  });
  // Radar power-up: every opponent for a few seconds.
  m.addLayer({
    id: "event-live",
    type: "circle",
    source: "event",
    filter: ["==", ["get", "kind"], "live"],
    paint: { "circle-radius": 8, "circle-color": "#ff5a4e", "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 },
  });
}

export function setEvent(m: MlMap, target: { lat: number; lng: number } | null, reachM: number, live: { lat: number; lng: number }[] = []) {
  const src = m.getSource<GeoJSONSource>("event");
  if (!src) return;
  const features: Feature[] = live.map((p) => ({
    type: "Feature",
    properties: { kind: "live" },
    geometry: { type: "Point", coordinates: [p.lng, p.lat] },
  }));
  if (target) {
    features.push(
      { type: "Feature", properties: { kind: "reach" }, geometry: { type: "Polygon", coordinates: [circleRing(target, reachM)] } },
      { type: "Feature", properties: { kind: "dot" }, geometry: { type: "Point", coordinates: [target.lng, target.lat] } },
    );
  }
  src.setData({ type: "FeatureCollection", features });
}

// ───────────────────────── 0009 (fase 5): teams ─────────────────────────

type Pt = { lat: number; lng: number };
const NEUTRAL = "#9aa3b2";

/**
 * Team objectives + teammates: flags (owner colour, capture ring tinted by
 * whoever is taking it), the hill (holder colour), teammates (my team colour,
 * initials) and quick-message markers. Under the safety layers (rule 4).
 */
export function addTeamLayer(m: MlMap) {
  m.addSource("team", { type: "geojson", data: EMPTY });
  const before = m.getLayer("forbidden-fill") ? "forbidden-fill" : undefined;
  m.addLayer({
    id: "team-area",
    type: "fill",
    source: "team",
    filter: ["==", ["get", "kind"], "area"],
    paint: { "fill-color": ["get", "color"], "fill-opacity": ["case", ["to-boolean", ["get", "taking"]], 0.4, 0.22] },
  }, before);
  m.addLayer({
    id: "team-area-line",
    type: "line",
    source: "team",
    filter: ["all", ["==", ["get", "kind"], "area"], ["!", ["to-boolean", ["get", "taking"]]]],
    paint: { "line-color": ["get", "line"], "line-width": 3 },
  }, before);
  // Someone is taking the flag: a dashed ring in the taker's colour.
  m.addLayer({
    id: "team-area-taking",
    type: "line",
    source: "team",
    filter: ["all", ["==", ["get", "kind"], "area"], ["to-boolean", ["get", "taking"]]],
    paint: { "line-color": ["get", "line"], "line-width": 5, "line-dasharray": [1.5, 1] },
  }, before);
  // Map fonts have no emoji: a coloured pin + a text label instead.
  m.addLayer({
    id: "team-flag",
    type: "circle",
    source: "team",
    filter: ["==", ["get", "kind"], "flag"],
    paint: { "circle-radius": 9, "circle-color": ["get", "color"], "circle-stroke-color": "#111827", "circle-stroke-width": 3 },
  });
  m.addLayer({
    id: "team-flag-label",
    type: "symbol",
    source: "team",
    filter: ["==", ["get", "kind"], "flag"],
    layout: { "text-field": ["get", "label"], "text-size": 13, "text-offset": [0, -1.6], "text-allow-overlap": true },
    paint: { "text-color": "#ffffff", "text-halo-color": "#111827", "text-halo-width": 2 },
  });
  m.addLayer({
    id: "team-mate",
    type: "circle",
    source: "team",
    filter: ["==", ["get", "kind"], "mate"],
    paint: { "circle-radius": 7, "circle-color": ["get", "color"], "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 },
  });
  m.addLayer({
    id: "team-mate-label",
    type: "symbol",
    source: "team",
    filter: ["any", ["==", ["get", "kind"], "mate"], ["==", ["get", "kind"], "msg"]],
    layout: { "text-field": ["get", "label"], "text-size": 12, "text-offset": [0, 1.4], "text-allow-overlap": true },
    paint: { "text-color": "#ffffff", "text-halo-color": "#111827", "text-halo-width": 2 },
  });
  m.addLayer({
    id: "team-msg",
    type: "circle",
    source: "team",
    filter: ["==", ["get", "kind"], "msg"],
    paint: { "circle-radius": 14, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": ["get", "color"], "circle-stroke-width": 4 },
  });
}

export interface TeamMapData {
  colorOf: (n: number | null | undefined) => string;
  flags?: { n: number; pos: Pt; owner: number | null; cap: number | null }[] | null;
  flagR?: number;
  hill?: { pos: Pt; r: number; holder: number | null } | null;
  mates?: { nickname: string; pos: Pt }[];
  mateColor?: string;
  msgs?: { label: string; pos: Pt | null }[];
  /** 0013 Stafett: the base ring and the course; `target` = my post (0-based), "base", or null. */
  relay?: { base: Pt; r: number; posts: { n: number; pos: Pt }[]; target?: number | "base" | null } | null;
}

export function setTeam(m: MlMap, d: TeamMapData | null) {
  const src = m.getSource<GeoJSONSource>("team");
  if (!src) return;
  if (!d) {
    src.setData(EMPTY);
    return;
  }
  const features: Feature[] = [];
  for (const f of d.flags ?? []) {
    const color = f.owner ? d.colorOf(f.owner) : NEUTRAL;
    features.push(
      {
        type: "Feature",
        properties: { kind: "area", color, line: f.cap ? d.colorOf(f.cap) : color, taking: !!f.cap },
        geometry: { type: "Polygon", coordinates: [circleRing(f.pos, d.flagR ?? 15)] },
      },
      { type: "Feature", properties: { kind: "flag", label: `Flagg ${f.n}`, color }, geometry: { type: "Point", coordinates: [f.pos.lng, f.pos.lat] } },
    );
  }
  if (d.hill) {
    const color = d.hill.holder ? d.colorOf(d.hill.holder) : NEUTRAL;
    features.push(
      { type: "Feature", properties: { kind: "area", color, line: color, taking: false }, geometry: { type: "Polygon", coordinates: [circleRing(d.hill.pos, d.hill.r)] } },
      { type: "Feature", properties: { kind: "flag", label: "Haugen", color }, geometry: { type: "Point", coordinates: [d.hill.pos.lng, d.hill.pos.lat] } },
    );
  }
  if (d.relay) {
    const gold = "#f5b800";
    const baseColor = d.relay.target === "base" ? gold : NEUTRAL;
    features.push(
      { type: "Feature", properties: { kind: "area", color: baseColor, line: baseColor, taking: false }, geometry: { type: "Polygon", coordinates: [circleRing(d.relay.base, d.relay.r)] } },
      { type: "Feature", properties: { kind: "flag", label: "Veksling", color: baseColor }, geometry: { type: "Point", coordinates: [d.relay.base.lng, d.relay.base.lat] } },
    );
    for (const p of d.relay.posts) {
      const on = d.relay.target === p.n;
      features.push({
        type: "Feature",
        properties: { kind: "flag", label: `Post ${p.n + 1}`, color: on ? gold : NEUTRAL },
        geometry: { type: "Point", coordinates: [p.pos.lng, p.pos.lat] },
      });
    }
  }
  // 0013: a big team (e.g. everybody waiting at the relay base) gets dots without name tags.
  const named = (d.mates ?? []).length <= 8;
  for (const mt of d.mates ?? []) {
    features.push({
      type: "Feature",
      properties: { kind: "mate", color: d.mateColor ?? NEUTRAL, label: named ? mt.nickname.slice(0, 10) : "" },
      geometry: { type: "Point", coordinates: [mt.pos.lng, mt.pos.lat] },
    });
  }
  for (const msg of d.msgs ?? []) {
    if (!msg.pos) continue;
    features.push({
      type: "Feature",
      properties: { kind: "msg", color: d.mateColor ?? NEUTRAL, label: msg.label },
      geometry: { type: "Point", coordinates: [msg.pos.lng, msg.pos.lat] },
    });
  }
  src.setData({ type: "FeatureCollection", features });
}
