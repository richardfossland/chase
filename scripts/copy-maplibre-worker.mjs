// Copies vendor files that a bundled Next chunk cannot resolve on its own into
// public/vendor/. Runs on postinstall so the copies always match the installed
// versions.
//
// 1. MapLibre 6 resolves its web worker relative to `import.meta.url`, which a
//    bundled Next chunk breaks (the worker URL 404s → "Worker failed to load").
//    We ship the self-contained worker as a static file and point MapLibre at
//    it with setWorkerUrl() (lib/map/maplibre.ts).
// 2. The QR scanner's zxing-wasm reader (barcode-detector polyfill) fetches its
//    .wasm from jsDelivr by default. We serve it ourselves instead
//    (lib/client/qrDetector.ts → /vendor/zxing_reader.wasm): no runtime CDN.
import { copyFileSync, mkdirSync } from "node:fs";

const dir = new URL("../public/vendor/", import.meta.url);
mkdirSync(dir, { recursive: true });

copyFileSync(
  new URL("../node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs", import.meta.url),
  new URL("maplibre-gl-worker.mjs", dir),
);
console.log("✓ copied maplibre-gl-worker.mjs → public/vendor/");

copyFileSync(
  new URL("../node_modules/zxing-wasm/dist/reader/zxing_reader.wasm", import.meta.url),
  new URL("zxing_reader.wasm", dir),
);
console.log("✓ copied zxing_reader.wasm → public/vendor/");
