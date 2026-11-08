import { channels, events } from "@/lib/realtime";
import { broadcast } from "@/lib/server/broadcast";
import { fail, isUuid } from "@/lib/server/http";
import { guarded, respond, rpc } from "@/lib/server/rpc";
import { parseBody } from "@/lib/server/route";
import { sosBody } from "@/lib/server/schemas";
import { sha256Hex } from "@/lib/server/tokens";

// SOS is never rate limited and its broadcast is awaited (not deferred):
// safety beats latency (CLAUDE.md rule 4). The host also sees it on the next poll.
export const POST = guarded(async (req, ctx) => {
  const { id } = await ctx.params;
  if (!isUuid(id)) return fail(404, "not_found");
  const body = await parseBody(req, sosBody);
  if (body instanceof Response) return body;
  const r = await rpc("raise_sos", {
    p_player: body.playerId,
    p_token_hash: await sha256Hex(body.token),
    p_lat: body.lat ?? null,
    p_lng: body.lng ?? null,
    p_session: id,
  });
  if (r.ok) await broadcast(channels.host(id), events.alarm, { kind: "sos" });
  return respond(r, (x) => ({ alarmId: x.alarm_id, new: x.new }));
});
