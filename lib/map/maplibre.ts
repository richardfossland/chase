// Single entry point for MapLibre in the client: loads the library lazily (it
// touches `window`) and points it at the statically served worker copied by
// scripts/copy-maplibre-worker.mjs. Always import MapLibre through this.
export async function loadMapLibre() {
  const ml = await import("maplibre-gl");
  const url = `/vendor/maplibre-gl-worker.mjs?v=${ml.getVersion()}`;
  if (ml.getWorkerUrl() !== url) ml.setWorkerUrl(url);
  return ml;
}
