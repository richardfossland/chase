import { describe, expect, it } from "vitest";
import { chooseDetector } from "@/lib/client/qrDetector";

const ctor = (formats?: string[] | Error) =>
  Object.assign(class {} as never, {
    getSupportedFormats: formats === undefined ? undefined : async () => (formats instanceof Error ? Promise.reject(formats) : formats),
  });

describe("chooseDetector", () => {
  it("uses the polyfill when there is no native detector", async () => {
    expect(await chooseDetector(undefined)).toBe("polyfill");
  });
  it("uses native when it supports qr_code", async () => {
    expect(await chooseDetector(ctor(["qr_code", "ean_13"]))).toBe("native");
  });
  it("uses native when it cannot list formats", async () => {
    expect(await chooseDetector(ctor())).toBe("native");
  });
  it("falls back when native lacks qr_code or throws", async () => {
    expect(await chooseDetector(ctor(["ean_13"]))).toBe("polyfill");
    expect(await chooseDetector(ctor(new Error("x")))).toBe("polyfill");
  });
});
