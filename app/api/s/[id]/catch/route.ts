import { channels, events } from "@/lib/realtime";
import { broadcast } from "@/lib/server/broadcast";
import { defer } from "@/lib/server/defer";
import { fail, isUuid } from "@/lib/server/http";
import { guarded, respond, rpc } from "@/lib/server/rpc";
import { limited, parseBody } from "@/lib/server/route";
import { catchBody } from "@/lib/server/schemas";
import { sha256Hex } from "@/lib/server/tokens";

// Smittejakt catch (PLAN §3.2): the hunter scanned the prey's QR or typed the
// 4-digit code. The server checks everything; the caught player's phone gets a
// hint so its screen flips at once. Rate limited so codes cannot be sprayed.
export const POST = guarded(async (req, ctx) => {
  const { id } = await ctx.params;
  if (!isUuid(id)) return fail(404, "not_found");
  const body = await parseBody(req, catchBody);
  if (body instanceof Response) return body;
  const rl = limited(`catch:${body.playerId}`, 20);
  if (rl) return rl;
  const r = await rpc("catch", {
    p_player: body.playerId,
    p_token_hash: await sha256Hex(body.token),
    p_session: id,
    p_code: body.code,
  });
  if (r.ok) {
    const prey = String(r.prey_id);
    defer(async () => {
      await broadcast(channels.player(id, prey), events.state);
      await broadcast(channels.host(id), events.roster);
      if (r.last) await broadcast(channels.all(id), events.state);
    }, "catch");
  }
  return respond(r, (x) => ({
    nickname: x.nickname,
    points: x.points,
    variant: x.variant,
    last: x.last,
    immuneUntil: x.immune_until ?? null,
    newBadges: x.new_badges ?? [],
  }));
});
