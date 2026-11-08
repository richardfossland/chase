import { fail, isUuid } from "@/lib/server/http";
import { guarded, respond, rpc } from "@/lib/server/rpc";
import { limited, parseBody } from "@/lib/server/route";
import { playerAuth } from "@/lib/server/schemas";
import { sha256Hex } from "@/lib/server/tokens";

// Player bootstrap: map geometry, teacher phone (for «Ring lærer»), status.
export const POST = guarded(async (req, ctx) => {
  const { id } = await ctx.params;
  if (!isUuid(id)) return fail(404, "not_found");
  const body = await parseBody(req, playerAuth);
  if (body instanceof Response) return body;
  const rl = limited(`me:${body.playerId}`, 30);
  if (rl) return rl;
  const r = await rpc("player_bootstrap", { p_player: body.playerId, p_token_hash: await sha256Hex(body.token), p_session: id });
  return respond(r, (x) => ({
    sessionId: x.session_id,
    playerId: x.player_id,
    nickname: x.nickname,
    status: x.status,
    teacherPhone: x.teacher_phone,
    geo: x.geo,
    serverNow: x.server_now,
  }));
});
