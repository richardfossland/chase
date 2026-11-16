import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let cfEnv: Record<string, unknown> | null = {};
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => {
    if (!cfEnv) throw new Error("no context");
    return { env: cfEnv };
  },
}));

import { liveFetch, liveNotify, liveTransport } from "@/lib/server/live";

const S = "11111111-2222-4333-8444-555555555555";

describe("lib/server/live", () => {
  beforeEach(() => {
    cfEnv = {};
    delete process.env.LIVE_DEV_URL;
    delete process.env.LIVE_TRANSPORT;
  });
  afterEach(() => vi.restoreAllMocks());

  it("transport is http unless the flag is exactly ws", () => {
    expect(liveTransport()).toBe("http");
    cfEnv = { LIVE_TRANSPORT: "ws" };
    expect(liveTransport()).toBe("ws");
    cfEnv = { LIVE_TRANSPORT: "WS" };
    expect(liveTransport()).toBe("http");
    cfEnv = null;
    process.env.LIVE_TRANSPORT = "ws";
    expect(liveTransport()).toBe("ws");
  });

  it("posts to the service binding and returns status + json", async () => {
    const fetch = vi.fn(async (req: Request) => {
      expect(new URL(req.url).pathname).toBe(`/live/s/${S}/tick`);
      expect(req.method).toBe("POST");
      return Response.json({ ok: 1 }, { status: 200 });
    });
    cfEnv = { LIVE: { fetch } };
    expect(await liveFetch(S, "tick", { a: 1 })).toEqual({ status: 200, json: { ok: 1 } });
  });

  it("returns null with no binding and no dev url", async () => {
    expect(await liveFetch(S, "tick", {})).toBeNull();
  });

  it("falls back to LIVE_DEV_URL", async () => {
    process.env.LIVE_DEV_URL = "http://127.0.0.1:8787/";
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ x: 1 }));
    expect(await liveFetch(S, "notify", { kind: "state" })).toEqual({ status: 200, json: { x: 1 } });
    expect(spy.mock.calls[0][0]).toBe(`http://127.0.0.1:8787/live/s/${S}/notify`);
  });

  it("returns null on timeout", async () => {
    vi.useFakeTimers();
    try {
      cfEnv = {
        LIVE: {
          fetch: (req: Request) =>
            new Promise((_, rej) => req.signal.addEventListener("abort", () => rej(new DOMException("x", "AbortError")))),
        },
      };
      const p = liveFetch(S, "tick", {});
      await vi.advanceTimersByTimeAsync(8001);
      expect(await p).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("notify is a no-op on http and swallows errors on ws", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("boom");
    });
    cfEnv = { LIVE: { fetch } };
    await liveNotify(S, "state");
    expect(fetch).not.toHaveBeenCalled();
    cfEnv = { LIVE: { fetch }, LIVE_TRANSPORT: "ws" };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(liveNotify(S, "alarm")).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith("[live] notify failed", S, "alarm", "unreachable");
  });
});
