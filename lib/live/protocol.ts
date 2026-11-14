import { z } from "zod";

import { tickBody, token, uuid } from "../server/schemas";

// Wire protocol between phones/teacher screens and the session room (Durable
// Objects stage 1, ADR-031). Shared by the room, the client and the sim.
//
// Tokens travel only in the first message, never in the URL (CLAUDE.md rule 7).
// The socket path carries the session id only. Positions are never logged.

/** Text frame the runtime answers itself (no wake-up), and its reply. */
export const PING = "ping";
export const PONG = "pong";

/** Frames larger than this are abuse: the socket is closed. */
export const MAX_FRAME = 1024;

export const CLOSE = {
  disabled: 4003, // kill switch (LIVE_ENABLED=0): fall back to HTTP
  bad_message: 4400,
  auth: 4401, // no/invalid auth within AUTH_TIMEOUT_MS
  kicked: 4403, // removed or left
  not_found: 4404,
  ended: 4410,
  rate: 4429,
  server: 4500,
} as const;

export const AUTH_TIMEOUT_MS = 5000;

const fixFields = tickBody.omit({ playerId: true, token: true });

const authMsg = z.discriminatedUnion("role", [
  z.object({ t: z.literal("auth"), role: z.literal("player"), playerId: uuid, token }),
  z.object({ t: z.literal("auth"), role: z.literal("host"), hostToken: token }),
]);

export const clientMsg = z.discriminatedUnion("t", [authMsg, fixFields.extend({ t: z.literal("fix") })]);
export type ClientMsg = z.infer<typeof clientMsg>;
export type FixMsg = Extract<ClientMsg, { t: "fix" }>;

/** Internal HTTP fallback body (Next route → room). The route has hashed the token. */
export const roomTickBody = fixFields.extend({
  playerId: uuid,
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type RoomTickBody = z.infer<typeof roomTickBody>;

/** A tick's personal view as the HTTP route returns it (internal flags stripped). */
export type TickView = Record<string, unknown>;

export type ServerMsg =
  | { t: "ready"; role: "player" | "host"; server_now: string }
  | { t: "view"; v: TickView }
  | { t: "err"; error: string }
  | { t: "hint" } // something changed for everybody: expect a fresh view soon
  | { t: "alarm" }; // host only: a new or escalated alarm, refetch now

/** Same stripping as app/api/s/[id]/tick/route.ts. */
export function stripView(r: Record<string, unknown>): TickView {
  const { ok: _ok, alert_host: _a, session_id: _s, hint_all: _h, ...view } = r;
  void _ok; void _a; void _s; void _h;
  return view;
}

/** Parse one text frame; null when it is not a valid client message. */
export function parseClientMsg(raw: string): ClientMsg | null {
  if (raw.length > MAX_FRAME) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const r = clientMsg.safeParse(json);
  return r.success ? r.data : null;
}
