import { beforeEach, describe, expect, it, vi } from "vitest";

import { isNoise, routePattern, sanitizeMessage, sanitizeStack, uaFamily } from "@/lib/errorSanitize";
import { POST } from "@/app/api/log/route";
import { __resetRateLimiter } from "@/lib/server/http";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const TOKEN = "AbCdEfGh1234567890_-AbCdEfGh1234";

describe("sanitering", () => {
  it("fjerner UUID, PIN, token, koordinater og query fra melding og stack", () => {
    const input = `Feil i /play/${UUID}?token=${TOKEN} pin 123456 pos 59.91273, 10.74609 key ${TOKEN}`;
    for (const out of [sanitizeMessage(input), sanitizeStack(`Error: ${input}\n at https://chase.sundaysuite.app/_next/a.js?x=1`)]) {
      expect(out).not.toContain(UUID);
      expect(out).not.toContain("123456");
      expect(out).not.toContain(TOKEN);
      expect(out).not.toContain("59.91273");
      expect(out).not.toContain("10.74609");
      expect(out).not.toContain("token=");
    }
  });
  it("beholder egne filstier uten query, og kutter lengde", () => {
    const s = sanitizeStack("at f (https://x.app/_next/static/a.js?v=2:1:1)", "https://x.app");
    expect(s).toContain("/_next/static/a.js");
    expect(s).not.toContain("v=2");
    expect(sanitizeMessage("a".repeat(1000)).length).toBe(300);
    expect(sanitizeStack("b ".repeat(2000)).length).toBe(1500);
  });
  it("normaliserer rute til mønster", () => {
    expect(routePattern(`/play/${UUID}`)).toBe("/play/[id]");
    expect(routePattern("/j/123456")).toBe("/j/[pin]");
    expect(routePattern("/d/ABC123?x=1")).toBe("/d/[code]");
    expect(routePattern("/hemmelig/123456")).toBe("/[x]");
  });
  it("ua-familie og støy", () => {
    expect(uaFamily("Mozilla/5.0 (iPhone; CPU iPhone OS 17) AppleWebKit Version/17 Safari/604")).toBe("iOS/Safari");
    expect(isNoise("ResizeObserver loop limit exceeded", undefined, null)).toBe(true);
    expect(isNoise("x", "at chrome-extension://abc/a.js", null)).toBe(true);
    expect(isNoise("x", "at https://cdn.other.com/a.js:1", "https://chase.sundaysuite.app")).toBe(true);
    expect(isNoise("TypeError", "at https://chase.sundaysuite.app/a.js:1", "https://chase.sundaysuite.app")).toBe(false);
  });
});

describe("POST /api/log", () => {
  beforeEach(() => __resetRateLimiter());
  const call = (b: unknown, ip = "1.1.1.1") =>
    POST(
      new Request("https://x.app/api/log", {
        method: "POST",
        headers: { "cf-connecting-ip": ip },
        body: JSON.stringify(b),
      }),
      { params: Promise.resolve({}) },
    );
  const ok = { message: "Boom", route: "/play/[id]", ua: "iOS/Safari", at: "2026-11-18T10:00:00Z" };

  it("svarer 204 og logger saneret", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await call({ ...ok, message: `Boom ${UUID} 59.91273` });
    expect(r.status).toBe(204);
    const line = String(spy.mock.calls[0][0]);
    expect(line).toContain('"kind":"client_error"');
    expect(line).not.toContain(UUID);
    expect(line).not.toContain("59.91273");
    spy.mockRestore();
  });
  it("avviser ugyldig body og rate-limiter per IP", async () => {
    expect((await call({ nope: 1 })).status).toBe(400);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    let last = 204;
    for (let i = 0; i < 25; i++) last = (await call(ok, "2.2.2.2")).status;
    expect(last).toBe(429);
    spy.mockRestore();
  });
});
