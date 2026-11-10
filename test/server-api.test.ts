import { describe, expect, it, vi } from "vitest";

import { isBlockedNickname, looksLikeFullName, normalizeNickname } from "@/lib/nickname";
import { respond, statusFor } from "@/lib/server/rpc";
import { createSessionBody, hostActionBody, tickBody } from "@/lib/server/schemas";
import { isTokenShape, newToken, sha256Hex } from "@/lib/server/tokens";

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({}) }));

describe("tokens", () => {
  it("are 43-char base64url and unique", () => {
    const a = newToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isTokenShape(a)).toBe(true);
    expect(newToken()).not.toBe(a);
  });
  it("hash to SHA-256 hex (same as SQL sha256())", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("reject garbage shapes", () => {
    expect(isTokenShape("short")).toBe(false);
    expect(isTokenShape("a".repeat(30) + "!")).toBe(false);
  });
});

describe("nickname", () => {
  it("normalises whitespace", () => expect(normalizeNickname("  Lyn   Rask ")).toBe("Lyn Rask"));
  it("blocks slurs even when obfuscated", () => {
    expect(isBlockedNickname("F.a.e.n")).toBe(true);
    expect(isBlockedNickname("Lynet")).toBe(false);
  });
  it("warns on full-name pattern", () => {
    expect(looksLikeFullName("Ola Nordmann")).toBe(true);
    expect(looksLikeFullName("Kari-Anne Hansen")).toBe(true);
    expect(looksLikeFullName("Lynet")).toBe(false);
    expect(looksLikeFullName("rask rev")).toBe(false);
  });
});

describe("rpc → http", () => {
  it("maps codes to statuses", () => {
    expect(statusFor("auth")).toBe(401);
    expect(statusFor("nickname_taken")).toBe(409);
    expect(statusFor("ended")).toBe(410);
    expect(statusFor("bad_boundary")).toBe(400);
  });
  it("passes extra fields on failure (e.g. missing list) and strips ok", async () => {
    const res = respond({ ok: false, error: "missing", missing: [{ id: "x" }] });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "missing", missing: [{ id: "x" }] });
    const okRes = respond({ ok: true, status: "live" });
    expect(await okRes.json()).toEqual({ status: "live" });
  });
});

describe("schemas", () => {
  const square = { type: "Polygon", coordinates: [[[10.75, 59.91], [10.7518, 59.91], [10.7518, 59.9109], [10.75, 59.91]]] };
  it("accepts a valid session body", () => {
    expect(createSessionBody.safeParse({ boundary: square, assembly: { type: "Point", coordinates: [10.75, 59.91] } }).success).toBe(true);
  });
  it("rejects out-of-range coordinates and unknown actions", () => {
    expect(tickBody.safeParse({ playerId: crypto.randomUUID(), token: newToken(), lat: 95, lng: 10, acc: 5 }).success).toBe(false);
    expect(hostActionBody.safeParse({ hostToken: newToken(), action: "drop_table" }).success).toBe(false);
  });
});

describe("tickBody speed", () => {
  it("drops an absurd speed instead of rejecting the fix", () => {
    const base = { playerId: "6c760c64-f172-4100-9d95-5d60b3c202c2", token: "a".repeat(32), lat: 59.9, lng: 10.7, acc: 5 };
    expect(tickBody.parse({ ...base, speed: 40000 }).speed).toBeNull();
    expect(tickBody.parse({ ...base, speed: -1 }).speed).toBeNull();
    expect(tickBody.parse({ ...base, speed: 3.2 }).speed).toBe(3.2);
    expect(tickBody.parse(base).speed).toBeNull();
  });
});
