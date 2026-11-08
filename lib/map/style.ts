import type { StyleSpecification } from "maplibre-gl";

// Kartverket topographic raster tiles (WMTS cache, Web Mercator, z/y/x).
// Free and open (CC BY 4.0) — attribution is required and shown on the map.
// Norwegian public source: no third-party tracking of pupils' map views.
const KARTVERKET_ATTRIBUTION =
  '© <a href="https://www.kartverket.no/" target="_blank" rel="noopener">Kartverket</a>';

export type BaseMap = "topo" | "topograatone";

export function kartverketStyle(layer: BaseMap = "topo"): StyleSpecification {
  return {
    version: 8,
    sources: {
      kartverket: {
        type: "raster",
        tiles: [`https://cache.kartverket.no/v1/wmts/1.0.0/${layer}/default/webmercator/{z}/{y}/{x}.png`],
        tileSize: 256,
        minzoom: 0,
        maxzoom: 18,
        attribution: KARTVERKET_ATTRIBUTION,
      },
    },
    layers: [{ id: "kartverket", type: "raster", source: "kartverket" }],
  };
}

/** Fallback centre when we have no GPS fix yet (Oslo). */
export const DEFAULT_CENTER: [number, number] = [10.7522, 59.9139];
