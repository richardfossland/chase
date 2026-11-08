import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { broadcast } from "@/lib/server/broadcast";

// broadcast() reads NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from
// process.env directly (no test seam there), so set both around every test and
// restore afterwards. The fetch implementation itself IS injectable
// (`fetchImpl`), which is what lets the timeout tests run under fake timers
// without a real network call.
const URL_ENV = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY_ENV = process.env.SUPABASE_SERVICE_ROLE_KEY;

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
});

afterEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = URL_ENV;
  process.env.SUPABASE_SERVICE_ROLE_KEY = KEY_ENV;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("broadcast — env guard", () => {
  it("no-ops without calling fetch when the Supabase env is missing", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    const fetchImpl = vi.fn();
    await broadcast("topic", "event", {}, 5000, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("broadcast — success/failure never throw", () => {
  it("resolves on a 2xx response and passes an abort signal", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return { ok: true, status: 200 } as Response;
    });
    await expect(
      broadcast("t1", "position", { fen: "x" }, 5000, fetchImpl as unknown as typeof fetch),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("swallows a non-OK response (logs, does not throw)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500 }) as Response);
    await expect(
      broadcast("t1", "position", {}, 5000, fetchImpl as unknown as typeof fetch),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "[broadcast] failed",
      "t1",
      "position",
      500,
    );
  });

  it("swallows a network error (logs, does not throw)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(
      broadcast("t1", "position", {}, 5000, fetchImpl as unknown as typeof fetch),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "[broadcast] error",
      "t1",
      "position",
      expect.any(TypeError),
    );
  });
});

describe("broadcast — hard timeout (regression: a hung fetch must never stall the caller)", () => {
  it("aborts a stalled request at the timeout and resolves instead of hanging", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Never resolves on its own; only settles (rejects) when the signal aborts —
    // exactly like a wedged Supabase Realtime REST call.
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const fail = () => reject(new DOMException("aborted", "AbortError"));
          if (init.signal?.aborted) fail();
          else init.signal?.addEventListener("abort", fail);
        }),
    );

    const p = broadcast("t1", "position", {}, 5000, fetchImpl as unknown as typeof fetch);
    const expectation = expect(p).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(5000);
    await expectation;

    expect(warn).toHaveBeenCalledWith("[broadcast] timeout", "t1", "position", 5000);
  });

  it("honours a custom timeoutMs", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const fail = () => reject(new DOMException("aborted", "AbortError"));
          if (init.signal?.aborted) fail();
          else init.signal?.addEventListener("abort", fail);
        }),
    );

    const p = broadcast("t1", "position", {}, 250, fetchImpl as unknown as typeof fetch);
    const expectation = expect(p).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(250);
    await expectation;

    expect(warn).toHaveBeenCalledWith("[broadcast] timeout", "t1", "position", 250);
  });

  it("does not fire the abort timer once the request settles in time", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }) as Response);

    await broadcast("t1", "position", {}, 5000, fetchImpl as unknown as typeof fetch);
    // Advance well past the timeout; nothing should fire since the timer was
    // cleared in `finally`.
    await vi.advanceTimersByTimeAsync(10_000);

    expect(warn).not.toHaveBeenCalled();
  });
});
