import { fail, isUuid } from "@/lib/server/http";
import { guarded, rpc } from "@/lib/server/rpc";
import { limited, parseBody } from "@/lib/server/route";
import { awayBody } from "@/lib/server/schemas";
import { sha256Hex } from "@/lib/server/tokens";

// 0024 live-belønning: the phone says «page hidden» (sendBeacon on visibilitychange/pagehide).
// It only marks `away_at` for the teacher's lock label: no game effect, no alarm, never delays one.
// The token comes from the JSON body (never the URL) and is never logged.
export const POST = guarded(async (req, ctx) => {
  const { id } = await ctx.params;
  if (!isUuid(id)) return fail(400, "bad_request");
  const body = await parseBody(req, awayBody);
  if (body instanceof Response) return body;
  const tokenHash = await sha256Hex(body.token);
  // Per token, not per IP: a whole class often shares one school IP.
  const rl = limited(`away:${tokenHash.slice(0, 16)}`, 12);
  if (rl) return rl;
  const r = await rpc("mark_away", { p_session: id, p_token_hash: tokenHash });
  if (!r.ok) return fail(400, "bad_request");
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
});
