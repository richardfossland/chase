import { channels, events } from "@/lib/realtime";
import { broadcast } from "@/lib/server/broadcast";
import { fail, isUuid } from "@/lib/server/http";
import { guarded, respond, rpc } from "@/lib/server/rpc";
import { parseBody } from "@/lib/server/route";
import { ackBody } from "@/lib/server/schemas";
import { sha256Hex } from "@/lib/server/tokens";

// Teacher acks an alarm. The pupil's «Læreren har sett det» is pushed at once.
export const POST = guarded(async (req, ctx) => {
  const { id } = await ctx.params;
  if (!isUuid(id)) return fail(404, "not_found");
  const body = await parseBody(req, ackBody);
  if (body instanceof Response) return body;
  const r = await rpc("ack_alarm", {
    p_session: id,
    p_alarm: body.alarmId,
    p_host_token_hash: await sha256Hex(body.hostToken),
  });
  if (r.ok && typeof r.player_id === "string") {
    await broadcast(channels.player(id, r.player_id), events.ack, { kind: String(r.kind) });
    await broadcast(channels.host(id), events.alarm);
  }
  return respond(r, (x) => ({ alarmId: x.alarm_id, kind: x.kind }));
});
