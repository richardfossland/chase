import "server-only";

import { createServiceClient } from "@/lib/supabase/service";
import { fail, ok } from "@/lib/server/http";

/** Every chase RPC returns jsonb: {ok:true,…} or {ok:false,error:'<code>',…}. */
export type RpcResult = { ok: boolean; error?: string } & Record<string, unknown>;

export async function rpc(fn: string, args: Record<string, unknown>): Promise<RpcResult> {
  const { data, error } = await createServiceClient().rpc(fn, args);
  if (error) {
    // Never log args: they can contain positions or token hashes.
    console.error(`[rpc:${fn}]`, error.code, error.message);
    throw new Error(`rpc_failed:${fn}`);
  }
  return data as RpcResult;
}

const STATUS: Record<string, number> = {
  auth: 401,
  bad_token: 401,
  no_session: 404,
  not_found: 404,
  no_player: 404,
  kicked: 403,
  left: 403,
  full: 409,
  nickname_taken: 409,
  code_clash: 409,
  bad_state: 409,
  missing: 409,
  stale: 409,
  ended: 410,
  area_size: 422,
  assembly_far: 422,
  bad_code: 404,
  not_now: 409,
  not_playing: 403,
  not_hunter: 403,
  too_far: 409,
  immune: 409,
  no_fix: 409,
  bad_adjust: 400,
  bad_role: 400,
  busy: 409,
  too_late: 409,
  no_target: 409,
  none_left: 409,
  not_useful: 409,
  none_pending: 409,
  no_teams: 409,
  teams_locked: 409,
  no_team: 409,
  too_soon: 429,
};

/** HTTP status for an RPC error code (bad_* and unknown → 400). */
export function statusFor(code: string): number {
  return STATUS[code] ?? 400;
}

/** Turn an RPC result into a Response; `pick` shapes the success DTO. */
export function respond(r: RpcResult, pick: (r: RpcResult) => unknown = strip) {
  if (!r.ok) {
    const { error, ...rest } = r;
    const code = error ?? "error";
    delete (rest as Record<string, unknown>).ok;
    return fail(statusFor(code), code, rest);
  }
  return ok(pick(r));
}

function strip(r: RpcResult) {
  const { ok: _ok, ...rest } = r;
  void _ok;
  return rest;
}

/** Wrap a handler so unexpected errors become a clean 500 JSON. */
export function guarded(handler: (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>) {
  return async (req: Request, ctx: { params: Promise<Record<string, string>> }) => {
    try {
      return await handler(req, ctx);
    } catch (e) {
      console.error("[api]", e instanceof Error ? e.message : "error");
      return fail(500, "server_error");
    }
  };
}
