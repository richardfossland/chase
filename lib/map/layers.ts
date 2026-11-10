import type { GeoJSONSource, Map as MlMap } from "maplibre-gl";

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
