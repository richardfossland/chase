import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

// Runs the real public/sw.js in a sandbox, so the test covers the shipped file.
const listeners: Record<string, (e: unknown) => void> = {};
const sandbox: Record<string, unknown> = {
  URL,
  self: { addEventListener: (t: string, fn: (e: unknown) => void) => (listeners[t] = fn) },
};
vm.createContext(sandbox);
vm.runInContext(readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"), sandbox);
const shouldCacheTile = (u: string, m?: string) => vm.runInContext(`shouldCacheTile(${JSON.stringify(u)}, ${JSON.stringify(m)})`, sandbox) as boolean;

const TILE = "https://cache.kartverket.no/v1/wmts/1.0.0/topo/default/webmercator/12/1/2.png";

describe("tile cache scope", () => {
  it("accepts Kartverket tiles", () => {
    expect(shouldCacheTile(TILE)).toBe(true);
    expect(shouldCacheTile(TILE, "GET")).toBe(true);
  });
  it("rejects non-GET", () => {
    expect(shouldCacheTile(TILE, "POST")).toBe(false);
  });
  it.each([
    "https://chase.sundaysuite.app/api/tick",
    "https://chase.sundaysuite.app/_next/static/chunks/a.js",
    "https://chase.sundaysuite.app/api/live/abc/ws",
    "wss://chase.sundaysuite.app/live/abc",
    "https://abc.supabase.co/rest/v1/x",
    "https://cache.kartverket.no.evil.com/v1/wmts/x.png",
    "https://evil.com/cache.kartverket.no/v1/wmts/x.png",
    "http://cache.kartverket.no/v1/wmts/x.png",
    "https://cache.kartverket.no/other/api",
    "https://tile.openstreetmap.org/1/2/3.png",
    "not a url",
  ])("rejects %s", (u) => {
    expect(shouldCacheTile(u)).toBe(false);
  });
  it("does not respondWith for non-tile requests", () => {
    let responded = false;
    listeners.fetch({ request: { url: "https://chase.sundaysuite.app/api/tick", method: "GET" }, respondWith: () => (responded = true) });
    expect(responded).toBe(false);
  });
});
