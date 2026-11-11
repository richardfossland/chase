import { channels, events } from "@/lib/realtime";
import { broadcast } from "@/lib/server/broadcast";
import { defer } from "@/lib/server/defer";
import { fail, isUuid } from "@/lib/server/http";
import { guarded, respond, rpc } from "@/lib/server/rpc";
import { limited, parseBody } from "@/lib/server/route";
import { hostActionBody } from "@/lib/server/schemas";
import { sha256Hex } from "@/lib/server/tokens";

export const POST = guarded(async (req, ctx) => {
  const { id } = await ctx.params;
  if (!isUuid(id)) return fail(404, "not_found");
  const rl = limited(`host:${id}`, 120);
  if (rl) return rl;
  const body = await parseBody(req, hostActionBody);
  if (body instanceof Response) return body;
  const payload = body.payload ?? {};
  const r = await rpc("host_action", {
    p_session: id,
    p_host_token_hash: await sha256Hex(body.hostToken),
    p_action: body.action,
    p_payload: payload,
  });
  if (r.ok) {
    defer(async () => {
      const target = payload.player_id;
      if (body.action === "message") {
        await broadcast(target ? channels.player(id, target) : channels.all(id), events.message);
      } else if (["kick", "rename", "sit_out", "check_in", "adjust_points", "set_role", "referee_award"].includes(body.action)) {
        if (target) await broadcast(channels.player(id, target), events.state);
        await broadcast(channels.host(id), events.roster);
      } else {
        await broadcast(channels.all(id), events.state);
        await broadcast(channels.host(id), events.state);
      }
    }, `host-${body.action}`);
  }
  return respond(r);
});
