import { describe, it, expect, vi } from "vitest";
import { Refetcher } from "@/lib/client/refetch";

/** Flush the promise chain inside Refetcher (run → catch → then). */
async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("Refetcher", () => {
  it("never runs two fetches at once, and a request during flight runs exactly one more", async () => {
    const gates: ReturnType<typeof deferred>[] = [];
    let runs = 0;
    const r = new Refetcher(async () => {
      runs++;
      const g = deferred();
      gates.push(g);
      await g.promise;
    });
    r.request();
    expect(runs).toBe(1);
    // Three hints while the first fetch is in flight → coalesce to ONE follow-up.
    r.request();
    r.request();
    r.request();
    expect(runs).toBe(1);
    gates[0].resolve();
    await settle();
    expect(runs).toBe(2);
    gates[1].resolve();
    await settle();
    expect(runs).toBe(2); // nothing queued → idle
    expect(r.busy).toBe(false);
  });

  it("jitter delays a hint-driven request; now() bypasses it", async () => {
    vi.useFakeTimers();
    let runs = 0;
    const r = new Refetcher(async () => void runs++, { jitterMs: 1000, random: () => 0.5 });
    r.request();
    expect(runs).toBe(0);
    vi.advanceTimersByTime(499);
    expect(runs).toBe(0);
    vi.advanceTimersByTime(1);
    expect(runs).toBe(1);
    await settle(); // let the first run finish so the next request is not just queued
    r.request();
    expect(runs).toBe(1); // jittered again
    r.now(); // cancels the pending jitter and runs immediately
    expect(runs).toBe(2);
    await settle();
    vi.advanceTimersByTime(2000);
    expect(runs).toBe(2);
    vi.useRealTimers();
  });

  it("a failing fetch still releases the in-flight slot", async () => {
    let runs = 0;
    const r = new Refetcher(async () => {
      runs++;
      throw new Error("boom");
    });
    r.request();
    await settle();
    r.request();
    await settle();
    expect(runs).toBe(2);
  });

  it("dispose stops queued and future work", async () => {
    const g = deferred();
    let runs = 0;
    const r = new Refetcher(async () => {
      runs++;
      await g.promise;
    });
    r.request();
    r.request(); // queued
    r.dispose();
    g.resolve();
    await settle();
    r.request();
    expect(runs).toBe(1);
  });
});
