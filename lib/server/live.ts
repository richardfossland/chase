import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";

import type { NotifyKind } from "@/lib/live/protocol";

// Next worker → chase-live session room (Durable Object), via the LIVE service
// binding. Internal only. Never log bodies: they contain positions (rule 3).

// tick: the room answers 503 itself after HTTP_WAIT_MS (3.5 s); this is only the
// backstop. Phones give up after 6 s, and the route still needs time for the
// direct-RPC fallback, so keep it well under that.
const TIMEOUT_MS = { tick: 4000, notify: 3000 } as const;

interface LiveEnv {
  LIVE?: { fetch(req: Request): Promise<Response> };
  LIVE_TRANSPORT?: string;
}

function env(): LiveEnv {
  try {
    return getCloudflareContext().env as unknown as LiveEnv;
  } catch {
    return {};
  }
}

export function liveTransport(): "http" | "ws" {
  const v = env().LIVE_TRANSPORT ?? process.env.LIVE_TRANSPORT;
  return v === "ws" ? "ws" : "http";
}

export interface LiveReply {
  status: number;
  json: unknown;
}

/** POST to the session room. null when unreachable, timed out or no binding. */
export async function liveFetch(
  session: string,
  kind: "tick" | "notify",
  body: unknown,
): Promise<LiveReply | null> {
  const path = `/live/s/${session}/${kind}`;
  const init = (signal: AbortSignal): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS[kind]);
  try {
    const e = env();
    let res: Response;
    if (e.LIVE) {
      res = await e.LIVE.fetch(new Request(`https://live${path}`, init(ctrl.signal)));
    } else if (process.env.LIVE_DEV_URL) {
      res = await fetch(`${process.env.LIVE_DEV_URL.replace(/\/$/, "")}${path}`, init(ctrl.signal));
    } else {
      return null;
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Fire-and-forget nudge to the room. Only when transport is ws; never throws. */
export async function liveNotify(session: string, kind: NotifyKind): Promise<void> {
  if (liveTransport() !== "ws") return;
  try {
    const r = await liveFetch(session, "notify", { kind });
    if (!r || r.status >= 400) console.warn("[live] notify failed", session, kind, r?.status ?? "unreachable");
  } catch {
    console.warn("[live] notify error", session, kind);
  }
}
