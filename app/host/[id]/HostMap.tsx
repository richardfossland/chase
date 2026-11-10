"use client";

import "maplibre-gl/dist/maplibre-gl.css";

import type { Map as MlMap, Marker } from "maplibre-gl";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

import type { HostPlayer, PostView, SessionGeo, SessionStatus } from "@/lib/client/api";
import { addPostsLayer, addSessionLayers, boundsOf, setPosts } from "@/lib/map/layers";
import { loadMapLibre } from "@/lib/map/maplibre";
import { kartverketStyle } from "@/lib/map/style";
import { SAFETY } from "@/lib/rules/safety";

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
    onSelect: (id: string) => void;
  }
>(function HostMap({ geo, players, posts, sosPlayers, status, onSelect }, ref) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const lib = useRef<Awaited<ReturnType<typeof loadMapLibre>> | null>(null);
  const markers = useRef<Map<string, { marker: Marker; el: HTMLDivElement }>>(new Map());
  const selectRef = useRef(onSelect);
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
        addPostsLayer(m);
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
    for (const p of players) {
      if (!p.pos) continue;
      seen.add(p.id);
      let entry = markers.current.get(p.id);
      if (!entry) {
        const el = document.createElement("div");
        el.className = "flex cursor-pointer flex-col items-center";
        el.innerHTML =
          '<span data-dot class="block size-5 rounded-full border-[3px] shadow-lg"></span>' +
          '<span data-name class="mt-0.5 rounded bg-black/70 px-1 text-[11px] font-bold leading-tight text-white"></span>';
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          selectRef.current(p.id);
        });
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
      entry.el.querySelector<HTMLElement>("[data-name]")!.textContent = `${p.nickname}${still ? " 💤" : ""}`;
      entry.el.setAttribute("aria-label", p.nickname);
    }
    for (const [id, entry] of markers.current) {
      if (!seen.has(id)) {
        entry.marker.remove();
        markers.current.delete(id);
      }
    }
  }, [ready, players, sosPlayers, status]);

  // Posts of the round: open in colour, taken in grey (teacher sees both).
  useEffect(() => {
    if (ready && map.current) setPosts(map.current, posts);
  }, [ready, posts]);

  return (
    <div className="absolute inset-0">
      <div ref={container} className="h-full w-full" />
    </div>
  );
});

export default HostMap;
