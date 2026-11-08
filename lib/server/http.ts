// Web-standard responses (no next/server dependency) so Route Handlers stay
// unit-testable in a plain Node environment.

export function ok<T>(data: T, init?: ResponseInit) {
  return Response.json(data, init);
}

export function fail(status: number, error: string, extra?: Record<string, unknown>) {
  return Response.json({ error, ...extra }, { status });
}

/** Parse a JSON body, returning null on malformed input. */
export async function readJson<T = Record<string, unknown>>(
  req: Request,
): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

// ---------- naive in-memory rate limiter ----------
// Per-process, best-effort. Good enough for a single-classroom deployment; the
// real backstop for abuse is server-side validation + the unique constraints.
// Documented in docs/RIG-TEST.md for a hardening pass (Upstash/edge KV) later.
//
// SELF-BOUNDING (critical on Cloudflare Workers): keys are high-cardinality
// (per-IP, and now per health-probe caller too), so without eviction this Map
// would grow for the whole isolate lifetime → memory pressure → Error 1102.
// Background timers don't run between Worker requests, so eviction must happen
// ON ACCESS: when the map gets large we sweep expired entries and, if still
// over the cap, evict the soonest-expiring ones so it can never approach the
// memory cliff.
const buckets = new Map<string, { count: number; resetAt: number }>();
const MAX_BUCKETS = 5000;

function sweep(now: number): void {
  for (const [k, v] of buckets) if (now > v.resetAt) buckets.delete(k);
  if (buckets.size > MAX_BUCKETS) {
    // Still over cap with all remaining entries live → drop the
    // soonest-to-expire until back under the cap.
    const live = [...buckets.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
    const drop = buckets.size - MAX_BUCKETS;
    for (let i = 0; i < drop; i++) buckets.delete(live[i][0]);
  }
}

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): boolean {
  const now = Date.now();
  if (buckets.size > MAX_BUCKETS) sweep(now);
  const b = buckets.get(key);
  if (!b || now > b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (b.count >= limit) return false;
  b.count++;
  return true;
}

/** Test-only: current number of tracked rate-limit buckets. */
export function __bucketCount(): number {
  return buckets.size;
}

/** Test-only: reset limiter state between tests. */
export function __resetRateLimiter(): void {
  buckets.clear();
}

// RFC-4122-ish: 8-4-4-4-12 hex groups. Deliberately lenient about
// version/variant nibbles — good enough to reject garbage ids (slugs, empty
// strings, SQL-ish input) before they reach PostgREST, not to validate a
// strict UUID grammar.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

export function clientIp(req: Request): string {
  // Prefer Cloudflare's CF-Connecting-IP: the edge sets it and the caller cannot
  // spoof it. X-Forwarded-For is client-supplied, so keying the rate limiter on
  // its first entry let an attacker send a random XFF per request and mint a
  // fresh bucket every time — defeating the control-code brute-force protection
  // on /api/attach entirely. Fall back to XFF only when CF header is absent.
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const fwd = req.headers.get("x-forwarded-for");
  return fwd?.split(",")[0]?.trim() || "local";
}
