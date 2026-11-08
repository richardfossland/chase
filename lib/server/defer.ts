import "server-only";

import { after } from "next/server";

/**
 * Run `task` AFTER the response has been flushed, never on the response path.
 *
 * Every referee write used to `await broadcast(...)` before returning: the
 * broadcast is a REST call to Supabase Realtime capped at 5 s, so the
 * referee's «Lagre» sat on a spinner for the hint's round-trip (and up to 5 s
 * when Realtime was slow) although the RPC had already committed the result.
 * Broadcasts are a hint layer — every client also polls and refetches on
 * focus — so nothing about the write's correctness depends on them. Respond
 * first, hint after.
 *
 * On Cloudflare, `after()` is backed by `ctx.waitUntil` (OpenNext passes it
 * into Next's request context), so the isolate stays alive until the deferred
 * work settles. Outside a Next request scope — vitest, `scripts/` — `after()`
 * throws synchronously; there the task is simply fired unawaited.
 *
 * Rejections are swallowed and logged: a failed broadcast must never surface
 * as an unhandled rejection, and the caller already has its 200.
 */
export function defer(task: () => Promise<void>, label: string): void {
  const run = () => task().catch((err) => console.error(`[defer:${label}]`, err));
  try {
    after(run);
  } catch {
    void run();
  }
}
