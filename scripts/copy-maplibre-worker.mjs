// MapLibre 6 resolves its web worker relative to `import.meta.url`, which a
// bundled Next chunk breaks (the worker URL 404s → "Worker failed to load").
// We ship the self-contained worker as a static file instead and point
// MapLibre at it with setWorkerUrl() (lib/map/maplibre.ts). Runs on
// postinstall so the copy always matches the installed version.
import { copyFileSync, mkdirSync } from "node:fs";

const src = new URL("../node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs", import.meta.url);
const dir = new URL("../public/vendor/", import.meta.url);
mkdirSync(dir, { recursive: true });
copyFileSync(src, new URL("maplibre-gl-worker.mjs", dir));
console.log("✓ copied maplibre-gl-worker.mjs → public/vendor/");
