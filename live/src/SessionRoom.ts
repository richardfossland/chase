import { DurableObject } from "cloudflare:workers";

import { RoomCore, type Attachment } from "../../lib/live/core";
import { CLOSE, PING, PONG, roomTickBody, type ServerMsg } from "../../lib/live/protocol";
import { sha256Hex } from "../../lib/server/tokens";
import { createDb } from "./db";

// One Durable Object per game session (ADR-031). A thin adapter: all logic is in
// lib/live/core.ts. WebSocket Hibernation API, so idle rooms cost nothing.
//
// Storage holds nothing personal: positions stay in memory (CLAUDE.md rule 3),
// socket attachments hold session id, role, player id and token hash only.

type SockMeta = Attachment & { session: string };

export class SessionRoom extends DurableObject<Env> {
  private core: RoomCore<WebSocket> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Heartbeats are answered by the runtime and never wake the room.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  private enabled(): boolean {
    return String(this.env.LIVE_ENABLED) !== "0";
  }

  private room(session: string): RoomCore<WebSocket> {
    if (this.core) return this.core;
    const core = new RoomCore<WebSocket>(session, {
      now: () => Date.now(),
      setTimer: (ms, fn) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      sha256Hex,
      db: createDb(String(this.env.SUPABASE_URL), this.env.SUPABASE_SERVICE_ROLE_KEY),
      send: (ws, msg: ServerMsg) => {
        try {
          ws.send(JSON.stringify(msg));
        } catch {
          /* socket already gone */
        }
      },
      close: (ws, code, reason) => {
        try {
          ws.close(code, reason);
        } catch {
          /* already closed */
        }
      },
      attach: (ws, a) => ws.serializeAttachment({ ...a, session } satisfies SockMeta),
    });
    // Woken from hibernation: the runtime kept the sockets, memory starts empty.
    for (const ws of this.ctx.getWebSockets()) core.restore(ws, ws.deserializeAttachment() as SockMeta | null);
    this.core = core;
    return core;
  }

  async fetch(req: Request): Promise<Response> {
    const session = req.headers.get("x-chase-session");
    if (!session) return Response.json({ error: "not_found" }, { status: 404 });
    const kind = new URL(req.url).pathname.split("/").pop();
    const core = this.room(session);

    if (kind === "ws") {
      if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return Response.json({ error: "upgrade_required" }, { status: 426 });
      }
      if (!this.enabled()) return Response.json({ error: "disabled" }, { status: 503 });
      if (core.isEnded) return Response.json({ error: "ended" }, { status: 410 });
      const origin = req.headers.get("Origin");
      const allowed = String(this.env.ALLOWED_ORIGINS).split(",").map((s) => s.trim());
      if (origin && !allowed.includes(origin)) return Response.json({ error: "origin" }, { status: 403 });

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ session } as Partial<SockMeta>);
      core.open(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (kind === "tick" && req.method === "POST") {
      const parsed = roomTickBody.safeParse(await req.json().catch(() => null));
      if (!parsed.success) return Response.json({ error: "bad_request" }, { status: 400 });
      const { playerId, tokenHash, ...fix } = parsed.data;
      const r = await core.httpTick(playerId, tokenHash, fix);
      return Response.json(r.body, { status: r.status });
    }

    if (kind === "stats") return Response.json(core.stats());
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const meta = ws.deserializeAttachment() as Partial<SockMeta> | null;
    if (!meta?.session) {
      ws.close(CLOSE.server, "no session");
      return;
    }
    const core = this.room(meta.session);
    if (!this.enabled()) {
      core.closeAll(CLOSE.disabled, "disabled");
      return;
    }
    if (typeof message !== "string") {
      core.closed(ws);
      ws.close(CLOSE.bad_message, "binary");
      return;
    }
    await core.message(ws, message);
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    this.core?.closed(ws);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "bye");
    } catch {
      /* already closed */
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.core?.closed(ws);
  }
}
