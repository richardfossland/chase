import { describe, expect, it } from "vitest";
import { buildCsp, securityHeaders } from "@/lib/security/headers";

const dir = (csp: string, name: string) =>
  csp.split("; ").find((p) => p.startsWith(name + " "))?.slice(name.length + 1).split(" ") ?? [];

describe("buildCsp", () => {
  const csp = buildCsp({ supabaseUrl: "https://abc.supabase.co" });
  it("er streng som standard", () => {
    expect(dir(csp, "default-src")).toEqual(["'self'"]);
    expect(dir(csp, "object-src")).toEqual(["'none'"]);
    expect(dir(csp, "base-uri")).toEqual(["'self'"]);
    expect(dir(csp, "form-action")).toEqual(["'self'"]);
    expect(dir(csp, "frame-ancestors")).toEqual(["'none'"]);
    expect(csp).toContain("upgrade-insecure-requests");
  });
  it("tillater zxing-wasm, workers og Kartverket-fliser", () => {
    expect(dir(csp, "script-src")).toContain("'wasm-unsafe-eval'");
    expect(dir(csp, "script-src")).not.toContain("'unsafe-eval'");
    expect(dir(csp, "worker-src")).toEqual(["'self'", "blob:"]);
    expect(dir(csp, "img-src")).toContain("https://cache.kartverket.no");
    expect(dir(csp, "connect-src")).toContain("https://cache.kartverket.no");
  });
  it("henter Supabase fra env-URL (https + wss), ikke hardkodet", () => {
    const c = dir(csp, "connect-src");
    expect(c).toContain("https://abc.supabase.co");
    expect(c).toContain("wss://abc.supabase.co");
    expect(csp).not.toContain("127.0.0.1");
  });
  it("lokal Supabase gir http + ws", () => {
    const c = dir(buildCsp({ supabaseUrl: "http://127.0.0.1:55321", dev: true }), "connect-src");
    expect(c).toContain("http://127.0.0.1:55321");
    expect(c).toContain("ws://127.0.0.1:55321");
  });
  it("tåler manglende og ugyldig env", () => {
    expect(dir(buildCsp({}), "connect-src")).toEqual(["'self'", "https://cache.kartverket.no"]);
    expect(dir(buildCsp({ supabaseUrl: "ikke en url" }), "connect-src")).toHaveLength(2);
  });
  it("dev får unsafe-eval, uten upgrade-insecure-requests", () => {
    const d = buildCsp({ dev: true });
    expect(dir(d, "script-src")).toContain("'unsafe-eval'");
    expect(d).not.toContain("upgrade-insecure-requests");
  });
  it("live ws-base legges til bare når satt", () => {
    expect(dir(buildCsp({ liveWsBase: "ws://127.0.0.1:8787" }), "connect-src")).toContain("ws://127.0.0.1:8787");
  });
});

describe("securityHeaders", () => {
  const map = (o = {}) => Object.fromEntries(securityHeaders(o).map((h) => [h.key, h.value]));
  it("prod har HSTS, Permissions-Policy, nosniff og Referrer-Policy", () => {
    const h = map();
    expect(h["Strict-Transport-Security"]).toBe("max-age=31536000; includeSubDomains");
    expect(h["Permissions-Policy"]).toContain("geolocation=(self)");
    expect(h["Permissions-Policy"]).toContain("camera=(self)");
    expect(h["Permissions-Policy"]).toContain("microphone=()");
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
  });
  it("dev sender ikke HSTS", () => {
    expect(map({ dev: true })["Strict-Transport-Security"]).toBeUndefined();
  });
});
