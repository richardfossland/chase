// Chase tile cache: remembers map tiles the pupil's map has ALREADY fetched, so
// the map still draws where they have been when the network drops.
//
// Hard limits (do not loosen without reading docs/PLAN.md and CLAUDE.md rules 3-4):
//  - Only GET https://cache.kartverket.no/v1/wmts/... is ever touched. Everything
//    else (API, /api/*, WebSocket, Next chunks, Supabase) is not intercepted at
//    all: no respondWith, so the browser goes straight to the network.
//  - No prefetch / bulk download. Kartverket's terms: zoom 12-20 contains Geovekst
//    data that must not be copied in bulk. This is only a runtime cache.
//  - No positions or API responses are ever stored, only PNG tiles.
//  - Opaque / non-200 responses are never stored (no quota traps).
const CACHE_PREFIX = "chase-tiles-";
const CACHE_NAME = CACHE_PREFIX + "v1";
const MAX_TILES = 3000;
const TRIM_EVERY = 50;
let putsSinceTrim = 0;

function shouldCacheTile(url, method) {
  if (method && method !== "GET") return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === "https:" && u.hostname === "cache.kartverket.no" && u.pathname.startsWith("/v1/wmts/");
}

function isStorable(res) {
  return !!res && res.status === 200 && res.type !== "opaque" && res.type !== "error";
}

async function trim(cache) {
  const keys = await cache.keys(); // insertion order: oldest first
  const extra = keys.length - MAX_TILES;
  for (let i = 0; i < extra; i++) await cache.delete(keys[i]);
}

async function revalidate(cache, request) {
  const res = await fetch(request);
  if (isStorable(res)) {
    await cache.put(request.url, res.clone());
    if (++putsSinceTrim >= TRIM_EVERY) {
      putsSinceTrim = 0;
      await trim(cache);
    }
  }
  return res;
}

async function handleTile(event) {
  const request = event.request;
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(request.url);
  if (hit) {
    // Stale-while-revalidate: answer from cache now, refresh in the background.
    event.waitUntil(revalidate(cache, request).catch(() => {}));
    return hit;
  }
  return revalidate(cache, request); // network error propagates as usual
}

if (typeof self !== "undefined" && self.addEventListener) {
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (event) => {
    event.waitUntil(
      (async () => {
        const names = await caches.keys();
        await Promise.all(names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== CACHE_NAME).map((n) => caches.delete(n)));
        await self.clients.claim();
      })(),
    );
  });
  self.addEventListener("fetch", (event) => {
    if (!shouldCacheTile(event.request.url, event.request.method)) return; // untouched
    event.respondWith(handleTile(event));
  });
}
