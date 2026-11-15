// Pure routing for the custom worker entry (worker.ts). Kept free of OpenNext
// imports so it is unit-testable.
//
// Only the WebSocket upgrade is public. /tick, /stats and /notify on the room
// are internal (service binding from the Next routes only): 404 from outside.

export interface LiveRouteEnv {
  LIVE_TRANSPORT?: string;
}

const LIVE_PATH = /^\/live\/s\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(ws|tick|stats|notify)$/;

export type RouteResult = "live" | "next" | Response;

export function route(req: Request, env: LiveRouteEnv): RouteResult {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/live/")) return "next";
  const m = LIVE_PATH.exec(url.pathname);
  if (!m) return Response.json({ error: "not_found" }, { status: 404 });
  if (m[1] !== "ws") return Response.json({ error: "not_found" }, { status: 404 });
  if (req.method !== "GET" || req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  if (env.LIVE_TRANSPORT !== "ws") return Response.json({ error: "disabled" }, { status: 404 });
  return "live";
}
