import { z } from "zod";

import { MAX_MESSAGE, MAX_STACK, routePattern, sanitizeMessage, sanitizeStack } from "@/lib/errorSanitize";
import { guarded } from "@/lib/server/rpc";
import { ipKey, limited, parseBody } from "@/lib/server/route";

// Klientfeil -> Workers Logs. Ingen lagring. Ingen persondata (CLAUDE.md regel 3): alt saneres på
// nytt her selv om klienten allerede har gjort det.
export const dynamic = "force-dynamic";

const MAX_BODY = 6_000;

const body = z.object({
  message: z.string().max(MAX_MESSAGE * 2),
  stack: z
    .string()
    .max(MAX_STACK * 2)
    .optional(),
  route: z.string().max(80),
  build: z.string().max(40).optional(),
  ua: z.string().max(40),
  at: z.string().max(40),
});

export const POST = guarded(async (req) => {
  const rl = limited(ipKey(req, "log"), 20);
  if (rl) return rl;
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY) return new Response(null, { status: 413 });
  const b = await parseBody(req, body);
  if (b instanceof Response) return b;
  console.error(
    JSON.stringify({
      kind: "client_error",
      message: sanitizeMessage(b.message),
      stack: sanitizeStack(b.stack),
      route: routePattern(b.route),
      build: b.build?.replace(/[^\w.-]/g, "").slice(0, 40),
      ua: b.ua.replace(/[^\w/ -]/g, "").slice(0, 40),
      at: b.at.replace(/[^\w:.+-]/g, "").slice(0, 40),
    }),
  );
  return new Response(null, { status: 204 });
});
