import { channels, events } from "@/lib/realtime";
import { broadcast } from "@/lib/server/broadcast";
import { defer } from "@/lib/server/defer";
import { fail, isUuid } from "@/lib/server/http";
import { guarded, respond, rpc } from "@/lib/server/rpc";
import { parseBody } from "@/lib/server/route";
import { endBody } from "@/lib/server/schemas";
import { sha256Hex } from "@/lib/server/tokens";

// End + privacy wipe. 409 {error:'missing', missing:[…]} until roll call is
// complete or the teacher confirms «Avslutt likevel» (force).
export const POST = guarded(async (req, ctx) => {
  const { id } = await ctx.params;
  if (!isUuid(id)) return fail(404, "not_found");
  const body = await parseBody(req, endBody);
  if (body instanceof Response) return body;
  const r = await rpc("end_session", {
    p_session: id,
    p_host_token_hash: await sha256Hex(body.hostToken),
    p_force: body.force === true,
  });
  if (r.ok) defer(() => broadcast(channels.all(id), events.state), "end");
  return respond(r);
});
