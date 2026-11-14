// chase-live: routes /live/s/<session>/(ws|tick|stats) to that session's room.
// Reachable only through the service binding from the Next worker (no routes,
// no workers.dev). Rooms live in the EU jurisdiction: children's positions never
// leave the EU (GDPR), and the database is in Stockholm.

export { SessionRoom } from "./SessionRoom";

const PATH = /^\/live\/s\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(ws|tick|stats)$/;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const m = PATH.exec(new URL(req.url).pathname);
    if (!m) return Response.json({ error: "not_found" }, { status: 404 });
    const session = m[1];
    // Local workerd has no jurisdictions: .dev.vars sets ROOM_JURISDICTION="".
    const jur = String(env.ROOM_JURISDICTION);
    const ns = jur === "eu" ? env.ROOM.jurisdiction("eu") : env.ROOM;
    const stub = ns.get(ns.idFromName(session));
    const headers = new Headers(req.headers);
    headers.set("x-chase-session", session);
    return stub.fetch(new Request(req, { headers }));
  },
} satisfies ExportedHandler<Env>;
