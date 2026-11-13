import { channels, events } from "@/lib/realtime";
import { broadcast } from "@/lib/server/broadcast";
import { defer } from "@/lib/server/defer";
import { fail, isUuid } from "@/lib/server/http";
import { guarded, respond, rpc } from "@/lib/server/rpc";
import { limited, parseBody } from "@/lib/server/route";
import { tickBody } from "@/lib/server/schemas";
import { sha256Hex } from "@/lib/server/tokens";

// The hot path (PLAN §9.2): one call per player every 2 s in a round.
// Never log the body — it is a position.
export const POST = guarded(async (req, ctx) => {
  const { id } = await ctx.params;
  if (!isUuid(id)) return fail(404, "not_found");
  const body = await parseBody(req, tickBody);
  if (body instanceof Response) return body;
  const rl = limited(`tick:${body.playerId}`, 90);
  if (rl) return rl;

  const r = await rpc("tick", {
    p_player: body.playerId,
    p_token_hash: await sha256Hex(body.token),
    p_lat: body.lat,
    p_lng: body.lng,
    p_acc: body.acc,
    p_speed: body.speed,
    p_client_ts: body.ts ? new Date(body.ts).toISOString() : null,
    p_session: id,
    p_steps: body.steps ?? null,
  });
  // Safety first: push the host a refetch hint the moment an alarm is new or escalated.
  if (r.ok && r.alert_host) defer(() => broadcast(channels.host(id), events.alarm), "tick-alarm");
  // A phase changed or a golden post appeared: every phone ticks now instead of on its next interval.
  if (r.ok && r.hint_all) defer(() => broadcast(channels.all(id), events.state), "tick-advance");
  return respond(r, (x) => {
    const { ok: _ok, alert_host: _a, session_id: _s, hint_all: _h, ...view } = x;
    void _ok; void _a; void _s; void _h;
    return view;
  });
});
