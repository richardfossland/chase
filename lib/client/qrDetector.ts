// QR detector selection for the camera scanner. The pure choice logic is split
// out so it can be tested; the polyfill (zxing-wasm, ~1 MB wasm) is loaded
// lazily and only when the browser has no usable native BarcodeDetector.

export type Detector = { detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]> };

type DetectorCtor = {
  new (o: { formats: string[] }): Detector;
  getSupportedFormats?: () => Promise<string[]>;
};

export type DetectorChoice = "native" | "polyfill";

/** Native BarcodeDetector if present and it supports qr_code, else the polyfill. */
export async function chooseDetector(native: DetectorCtor | undefined | null): Promise<DetectorChoice> {
  if (!native) return "polyfill";
  try {
    const formats = (await native.getSupportedFormats?.()) ?? ["qr_code"];
    return formats.includes("qr_code") ? "native" : "polyfill";
  } catch {
    return "polyfill";
  }
}

/** Same-origin wasm (copied to public/vendor by scripts/copy-maplibre-worker.mjs). */
export const WASM_URL = "/vendor/zxing_reader.wasm";

export async function createQrDetector(): Promise<Detector> {
  const native = (globalThis as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
  if (native && (await chooseDetector(native)) === "native") return new native({ formats: ["qr_code"] });

  const { BarcodeDetector, prepareZXingModule } = await import("barcode-detector/ponyfill");
  prepareZXingModule({
    overrides: { locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? WASM_URL : prefix + path) },
    fireImmediately: true,
  });
  return new BarcodeDetector({ formats: ["qr_code"] }) as unknown as Detector;
}
