import { channels, events } from "@/lib/realtime";
import { broadcast } from "@/lib/server/broadcast";
import { defer } from "@/lib/server/defer";
import { fail, isUuid } from "@/lib/server/http";
import { guarded, respond, rpc } from "@/lib/server/rpc";
import { limited, parseBody } from "@/lib/server/route";
import { againBody } from "@/lib/server/schemas";
import { sha256Hex } from "@/lib/server/tokens";

// «Vil spille igjen?» after the ceremony (PLAN §13 fase 3). Only a count is
// kept — the server stores no link between the answer and the player.
export const POST = guarded(async (req, ctx) => {
  const { id } = await ctx.params;
  if (!isUuid(id)) return fail(404, "not_found");
  const body = await parseBody(req, againBody);
  if (body instanceof Response) return body;
  const rl = limited(`again:${body.playerId}`, 10);
  if (rl) return rl;
  const r = await rpc("vote_again", {
    p_player: body.playerId,
    p_token_hash: await sha256Hex(body.token),
    p_session: id,
    p_yes: body.yes,
  });
  if (r.ok && !r.already) defer(() => broadcast(channels.host(id), events.state), "again");
  return respond(r, (x) => ({ already: !!x.already }));
});
