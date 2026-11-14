import { describe, expect, it } from "vitest";

import { MAX_FRAME, parseClientMsg, roomTickBody, stripView } from "@/lib/live/protocol";

const playerId = "11111111-2222-4333-8444-555555555555";
const token = "abcdefghijklmnopqrstuvwxyz012345";

describe("live protocol", () => {
  it("parses player and host auth", () => {
    expect(parseClientMsg(JSON.stringify({ t: "auth", role: "player", playerId, token }))).toMatchObject({ role: "player" });
    expect(parseClientMsg(JSON.stringify({ t: "auth", role: "host", hostToken: token }))).toMatchObject({ role: "host" });
  });

  it("rejects malformed auth", () => {
    expect(parseClientMsg(JSON.stringify({ t: "auth", role: "player", playerId, token: "short" }))).toBeNull();
    expect(parseClientMsg(JSON.stringify({ t: "auth", role: "player", playerId: "x", token }))).toBeNull();
    expect(parseClientMsg(JSON.stringify({ t: "auth", role: "admin", token }))).toBeNull();
  });

  it("parses a fix with the tick body's rules", () => {
    const m = parseClientMsg(JSON.stringify({ t: "fix", lat: 59.91, lng: 10.75, acc: 5, speed: 999, ts: 1, steps: 3 }));
    expect(m).toMatchObject({ t: "fix", lat: 59.91, speed: null, steps: 3 }); // absurd speed dropped, fix kept
    expect(parseClientMsg(JSON.stringify({ t: "fix", lat: 91, lng: 10, acc: 5 }))).toBeNull();
    expect(parseClientMsg(JSON.stringify({ t: "fix", lat: 59, lng: 10, acc: 5, steps: 501 }))).toBeNull();
  });

  it("rejects garbage and oversized frames", () => {
    expect(parseClientMsg("not json")).toBeNull();
    expect(parseClientMsg(JSON.stringify({ t: "nope" }))).toBeNull();
    expect(parseClientMsg(JSON.stringify({ t: "fix", lat: 1, lng: 1, acc: 1, pad: "x".repeat(MAX_FRAME) }))).toBeNull();
  });

  it("room tick body needs a sha-256 hex hash, never a raw token", () => {
    const hash = "a".repeat(64);
    expect(roomTickBody.safeParse({ playerId, tokenHash: hash, lat: 1, lng: 1, acc: 1 }).success).toBe(true);
    expect(roomTickBody.safeParse({ playerId, tokenHash: token, lat: 1, lng: 1, acc: 1 }).success).toBe(false);
  });

  it("strips internal flags like the tick route", () => {
    expect(stripView({ ok: true, alert_host: true, hint_all: false, session_id: "s", status: "live", stats: {} }))
      .toEqual({ status: "live", stats: {} });
  });
});
