import { describe, expect, it } from "vitest";
import { route } from "@/lib/server/liveRoute";

const ID = "11111111-2222-4333-8444-555555555555";
const ws = (path: string, method = "GET", upgrade = true) =>
  new Request(`https://chase.sundaysuite.app${path}`, { method, headers: upgrade ? { upgrade: "websocket" } : {} });

describe("worker route()", () => {
  it("forwards the websocket upgrade only when LIVE_TRANSPORT is ws", async () => {
    expect(route(ws(`/live/s/${ID}/ws`), { LIVE_TRANSPORT: "ws" })).toBe("live");
    const off = route(ws(`/live/s/${ID}/ws`), { LIVE_TRANSPORT: "http" });
    expect(off).toBeInstanceOf(Response);
    expect((off as Response).status).toBe(404);
    expect(await (off as Response).json()).toEqual({ error: "disabled" });
    expect((route(ws(`/live/s/${ID}/ws`), {}) as Response).status).toBe(404);
  });

  it("404s internal kinds from the public path, even with ws on", () => {
    for (const k of ["tick", "stats", "notify"]) {
      const r = route(ws(`/live/s/${ID}/${k}`, "POST", false), { LIVE_TRANSPORT: "ws" });
      expect(r).toBeInstanceOf(Response);
      expect((r as Response).status).toBe(404);
    }
  });

  it("404s non-upgrade requests and malformed live paths", () => {
    expect((route(ws(`/live/s/${ID}/ws`, "GET", false), { LIVE_TRANSPORT: "ws" }) as Response).status).toBe(404);
    expect((route(ws(`/live/s/nope/ws`), { LIVE_TRANSPORT: "ws" }) as Response).status).toBe(404);
  });

  it("sends everything else to Next", () => {
    for (const p of ["/", "/api/s/" + ID + "/tick", "/play/" + ID, "/liveness"]) {
      expect(route(new Request(`https://chase.sundaysuite.app${p}`, { method: "POST" }), { LIVE_TRANSPORT: "ws" })).toBe("next");
    }
  });
});
