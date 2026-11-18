import { fail, isUuid } from "@/lib/server/http";
import { guarded, respond, rpc } from "@/lib/server/rpc";
import { limited, parseBody } from "@/lib/server/route";
import { hostAuth } from "@/lib/server/schemas";
import { sha256Hex } from "@/lib/server/tokens";

// Øktrapport til læreren (0019). POST så lærertokenet holdes ute av URL-er.
// Leser bare; ingenting lagres, og svaret har ingen posisjoner.
export const POST = guarded(async (req, ctx) => {
  const { id } = await ctx.params;
  if (!isUuid(id)) return fail(404, "not_found");
  const rl = limited(`report:${id}`, 20);
  if (rl) return rl;
  const body = await parseBody(req, hostAuth);
  if (body instanceof Response) return body;
  const r = await rpc("session_report", { p_session: id, p_host_token_hash: await sha256Hex(body.hostToken) });
  return respond(r);
});
