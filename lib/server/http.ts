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
// Copied from SundayQuiz; a shared edge-KV limiter is a later hardening pass.
const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (b.count >= limit) return false;
  b.count++;
  return true;
}

export function clientIp(req: Request): string {
  // Cloudflare sets CF-Connecting-IP to the real client IP and OVERWRITES any
  // client-supplied value, so it can't be spoofed. X-Forwarded-For, by contrast,
  // is caller-appendable — keying the per-IP rate limit on its first hop let an
  // attacker dodge the limit (esp. the AI-generate endpoint) by rotating a fake
  // hop. Prefer CF-Connecting-IP; fall back to the first XFF hop (other proxies /
  // local dev), then a constant.
  const cf = req.headers.get("cf-connecting-ip");
  if (cf?.trim()) return cf.trim();
  const fwd = req.headers.get("x-forwarded-for");
  return fwd?.split(",")[0]?.trim() || "local";
}
