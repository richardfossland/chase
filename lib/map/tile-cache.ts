// Registers /sw.js, which caches only map tiles the map has already fetched
// (see public/sw.js). Production only; idempotent; silent on failure.
// Scope /play/ only: teacher pages (alarm polling) are never controlled by it.
let registered = false;

export function registerTileCache(): void {
  if (registered || typeof window === "undefined") return;
  if (process.env.NODE_ENV !== "production") return;
  if (!("serviceWorker" in navigator)) return;
  registered = true;
  const go = () => void navigator.serviceWorker.register("/sw.js", { scope: "/play/" }).catch(() => {});
  if (document.readyState === "complete") go();
  else window.addEventListener("load", go, { once: true });
}
