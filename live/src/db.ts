import type { AuthResult, BatchResult, RoomDb, TickEntry } from "../../lib/live/core";

// The room's database access: PostgREST RPC with the service key, the same path
// and privileges as the Next routes (lib/server/rpc.ts). Arguments are never
// logged — they hold positions and token hashes.

const TIMEOUT_MS = 8000;

type Json = { ok?: boolean; error?: string } & Record<string, unknown>;

export function createDb(url: string, key: string): RoomDb {
  async function rpc(fn: string, args: Record<string, unknown>): Promise<Json> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
        method: "POST",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "Content-Profile": "chase",
          Accept: "application/json",
        },
        body: JSON.stringify(args),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        console.error(`[live:rpc:${fn}] http ${res.status}`);
        throw new Error(`rpc_failed:${fn}`);
      }
      return (await res.json()) as Json;
    } finally {
      clearTimeout(t);
    }
  }

  const auth = (r: Json): AuthResult =>
    r.error ? { ok: false, error: r.error } : { ok: r.ok !== false };

  return {
    tickBatch: async (session: string, entries: TickEntry[]) =>
      (await rpc("tick_batch", { p_session: session, p_ticks: entries })) as unknown as BatchResult,
    playerAuth: async (session, playerId, tokenHash) =>
      auth(await rpc("player_bootstrap", { p_player: playerId, p_token_hash: tokenHash, p_session: session })),
    hostAuth: async (session, hostTokenHash) =>
      auth(await rpc("host_snapshot", { p_session: session, p_host_token_hash: hostTokenHash, p_include_geo: false })),
  };
}
