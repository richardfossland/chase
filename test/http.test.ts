import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __bucketCount,
  __resetRateLimiter,
  clientIp,
  isUuid,
  rateLimit,
} from "@/lib/server/http";

const reqWith = (headers: Record<string, string>) =>
  new Request("https://chase.sundaysuite.app/api/attach", { headers });

describe("clientIp", () => {
  it("prefers the un-spoofable CF-Connecting-IP over X-Forwarded-For", () => {
    const req = reqWith({
      "cf-connecting-ip": "203.0.113.7",
      "x-forwarded-for": "1.1.1.1, 2.2.2.2",
    });
    expect(clientIp(req)).toBe("203.0.113.7");
  });

  it("falls back to the first X-Forwarded-For entry when CF header is absent", () => {
    expect(clientIp(reqWith({ "x-forwarded-for": "9.9.9.9, 8.8.8.8" }))).toBe("9.9.9.9");
  });

  it("returns 'local' when no IP headers are present", () => {
    expect(clientIp(reqWith({}))).toBe("local");
  });

  it("a forged X-Forwarded-For cannot mint a fresh bucket once CF-Connecting-IP is set", () => {
    const a = clientIp(reqWith({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "r1" }));
    const b = clientIp(reqWith({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "r2" }));
    expect(a).toBe(b);
  });
});

describe("rateLimit", () => {
  it("allows up to `limit` calls then blocks within the window", () => {
    const key = `t-${Math.random()}`;
    expect(rateLimit(key, 2, 60_000)).toBe(true);
    expect(rateLimit(key, 2, 60_000)).toBe(true);
    expect(rateLimit(key, 2, 60_000)).toBe(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sweeps expired buckets once the map exceeds the cap, instead of growing forever", () => {
    __resetRateLimiter();
    const start = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(start);

    // Fill past the 5000-bucket cap with entries that expire almost instantly.
    for (let i = 0; i < 5001; i++) {
      rateLimit(`sweep-${i}`, 1, 1);
    }
    expect(__bucketCount()).toBe(5001);

    // Move past every bucket's resetAt. The next call sees size > cap and
    // sweeps first — since everything is expired, the sweep clears all of
    // them before inserting the new key.
    vi.setSystemTime(start + 10);
    rateLimit("after-sweep", 1, 60_000);
    expect(__bucketCount()).toBe(1);
  });
});

describe("isUuid", () => {
  it("accepts a well-formed v4-shaped UUID", () => {
    expect(isUuid("11111111-1111-1111-1111-111111111111")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isUuid("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")).toBe(true);
  });

  it("rejects non-UUID strings", () => {
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("")).toBe(false);
    expect(isUuid("11111111-1111-1111-1111-11111111111")).toBe(false); // short
    expect(isUuid("11111111111111111111111111111111")).toBe(false); // no dashes
  });

  it("rejects non-string input", () => {
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(isUuid(12345)).toBe(false);
    expect(isUuid({ id: "11111111-1111-1111-1111-111111111111" })).toBe(false);
  });
});
