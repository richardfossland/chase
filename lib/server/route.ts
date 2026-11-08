import "server-only";

import type { z } from "zod";

import { clientIp, fail, rateLimit, readJson } from "@/lib/server/http";

/** Parse + validate a JSON body. Returns the data or a 400 Response. */
export async function parseBody<S extends z.ZodType>(req: Request, schema: S): Promise<z.infer<S> | Response> {
  const body = await readJson(req);
  if (body === null) return fail(400, "bad_json");
  const r = schema.safeParse(body);
  if (!r.success) return fail(400, "bad_request");
  return r.data;
}

/** Rate limit by key; returns a 429 Response when exceeded. */
export function limited(key: string, limit: number, windowMs = 60_000): Response | null {
  return rateLimit(key, limit, windowMs) ? null : fail(429, "rate_limited");
}

export function ipKey(req: Request, scope: string) {
  return `${scope}:${clientIp(req)}`;
}
