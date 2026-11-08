"use client";

import "maplibre-gl/dist/maplibre-gl.css";

import type { GeoJSONSource, GeolocatePositionEvent, Map as MlMap } from "maplibre-gl";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { circleRing, ringArea, type LngLat } from "@/lib/geo";
import { no } from "@/lib/locale/no";
import { loadMapLibre } from "@/lib/map/maplibre";
import { DEFAULT_CENTER, kartverketStyle } from "@/lib/map/style";

const AREA_SOURCE = "area";

function areaFeature(center: LngLat, radius: number) {
  return {
    type: "Feature" as const,
    properties: {},
    geometry: { type: "Polygon" as const, coordinates: [circleRing(center, radius).map((p) => [...p])] },
  };
}

/**
 * Phase-0 proof: MapLibre + Kartverket tiles render on a phone, the browser
 * gives us a GPS fix, and our geo maths draws a play area around it.
 */
export default function AreaMapDemo() {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const [center, setCenter] = useState<LngLat | null>(null);
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [radius, setRadius] = useState(150);
  const [gpsError, setGpsError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { Map, NavigationControl, GeolocateControl } = await loadMapLibre();
      if (cancelled || !container.current) return;
      const m = new Map({
        container: container.current,
        style: kartverketStyle("topo"),
        center: DEFAULT_CENTER,
        zoom: 15,
        attributionControl: { compact: true },
      });
      m.addControl(new NavigationControl({ showCompass: false }), "top-right");
      const geo = new GeolocateControl({
        positionOptions: { enableHighAccuracy: true, maximumAge: 0 },
        trackUserLocation: true,
        showAccuracyCircle: true,
      });
      m.addControl(geo, "top-right");
      geo.on("geolocate", (e: GeolocatePositionEvent) => {
        setGpsError(false);
        setAccuracy(e.coords.accuracy);
        setCenter((prev) => prev ?? [e.coords.longitude, e.coords.latitude]);
      });
      geo.on("error", () => setGpsError(true));
      m.on("load", () => {
        m.addSource(AREA_SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        m.addLayer({
          id: "area-fill",
          type: "fill",
          source: AREA_SOURCE,
          paint: { "fill-color": "#ebb84b", "fill-opacity": 0.15 },
        });
        m.addLayer({
          id: "area-line",
          type: "line",
          source: AREA_SOURCE,
          paint: { "line-color": "#ebb84b", "line-width": 3 },
        });
        geo.trigger();
      });
      map.current = m;
    })();
    return () => {
      cancelled = true;
      map.current?.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m || !center) return;
    const apply = () => {
      const src = m.getSource<GeoJSONSource>(AREA_SOURCE);
      src?.setData(areaFeature(center, radius));
    };
    if (m.isStyleLoaded()) apply();
    else m.once("load", apply);
  }, [center, radius]);

  const area = Math.PI * radius * radius;
  const ringAreaM2 = center ? ringArea(circleRing(center, radius)) : area;

  return (
    <div className="relative h-dvh w-full">
      {/* maplibre-gl.css is unlayered and sets .maplibregl-map{position:relative},
          which beats Tailwind's layered utilities — so position a wrapper and
          let the map element just fill it. */}
      <div className="absolute inset-0">
        <div ref={container} className="h-full w-full" />
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="pointer-events-auto mx-auto max-w-md rounded-2xl border border-line bg-ink-2/95 p-4 shadow-2xl backdrop-blur">
          <div className="flex items-baseline justify-between gap-3">
            <h1 className="text-lg font-extrabold">{no.map.circleAroundMe}</h1>
            <Link href="/" className="text-sm text-txt-dim underline-offset-4 hover:underline">
              {no.map.back}
            </Link>
          </div>
          <p className="mt-1 text-sm text-txt-dim">{no.map.hint}</p>
          <label className="mt-3 block">
            <span className="flex justify-between text-sm font-semibold">
              <span>{no.map.radius(radius)}</span>
              <span className="text-txt-dim">{no.map.area(ringAreaM2)}</span>
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
          {accuracy !== null && (
            <p className={`mt-2 text-sm font-semibold ${accuracy <= 15 ? "text-ok" : accuracy <= 30 ? "text-warn" : "text-danger"}`}>
              {no.map.accuracy(accuracy)}
            </p>
          )}
          {gpsError && <p className="mt-2 text-sm font-semibold text-danger">{no.map.noGps}</p>}
        </div>
      </div>
    </div>
  );
}
