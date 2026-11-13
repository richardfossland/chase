"use client";

// A small SVG outline of an area (boundary, forbidden zones, assembly point)
// for library lists and share previews — no map tiles, no network.

import type { AreaGeo } from "@/lib/client/api";

export function AreaThumb({ area, size = 64 }: { area: AreaGeo; size?: number }) {
  const ring = area.boundary.coordinates[0];
  const lat0 = (ring.reduce((s, p) => s + p[1], 0) / ring.length) * (Math.PI / 180);
  const xy = (p: number[]) => [p[0] * Math.cos(lat0), -p[1]] as const;
  const pts = ring.map(xy);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const span = Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY) || 1;
  const pad = 4;
  const k = (size - 2 * pad) / span;
  const to = (p: number[]) => {
    const [x, y] = xy(p);
    return `${(pad + (x - minX) * k).toFixed(1)},${(pad + (y - minY) * k).toFixed(1)}`;
  };
  const a = to([area.assembly.lng, area.assembly.lat]).split(",").map(Number);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="flex-none rounded-lg bg-ink" aria-hidden>
      <polygon points={ring.map(to).join(" ")} fill="#ebb84b33" stroke="#ebb84b" strokeWidth={2} />
      {area.forbidden?.coordinates.map((poly, i) => (
        <polygon key={i} points={poly[0].map(to).join(" ")} fill="#ff3b3066" stroke="#ff3b30" strokeWidth={1} />
      ))}
      <circle cx={a[0]} cy={a[1]} r={3.5} fill="#4fd18b" stroke="#fff" strokeWidth={1.5} />
    </svg>
  );
}
