import { channels, events } from "@/lib/realtime";
import { broadcast } from "@/lib/server/broadcast";
import { defer } from "@/lib/server/defer";
import { guarded, respond, rpc } from "@/lib/server/rpc";
import { limited, parseBody } from "@/lib/server/route";
import { snapshotBody } from "@/lib/server/schemas";
import { sha256Hex } from "@/lib/server/tokens";
import { isUuid, fail } from "@/lib/server/http";

// Teacher panel poll (every 2 s). POST, so the host token stays out of URLs.
export const POST = guarded(async (req, ctx) => {
  const { id } = await ctx.params;
  if (!isUuid(id)) return fail(404, "not_found");
  const rl = limited(`snapshot:${id}`, 120);
  if (rl) return rl;
  const body = await parseBody(req, snapshotBody);
  if (body instanceof Response) return body;
  const r = await rpc("host_snapshot", {
    p_session: id,
    p_host_token_hash: await sha256Hex(body.hostToken),
    p_include_geo: body.geo === true,
  });
  // A new signal-loss alarm: wake any other host device too.
  if (r.ok && r.alert_host) defer(() => broadcast(channels.host(id), events.alarm), "snapshot-alarm");
  if (r.ok && r.hint_all) defer(() => broadcast(channels.all(id), events.state), "snapshot-advance");
  return respond(r, (x) => {
    const { ok: _ok, alert_host: _a, hint_all: _h, ...rest } = x;
    void _ok; void _a; void _h;
    return rest;
  });
});
