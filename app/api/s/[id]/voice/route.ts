import { channels, events } from "@/lib/realtime";
import { broadcast } from "@/lib/server/broadcast";
import { liveNotify } from "@/lib/server/live";
import { defer } from "@/lib/server/defer";
import { fail, isUuid } from "@/lib/server/http";
import { guarded, respond, rpc } from "@/lib/server/rpc";
import { limited, parseBody } from "@/lib/server/route";
import { voiceBody } from "@/lib/server/schemas";
import { sha256Hex } from "@/lib/server/tokens";

// Talte varsler av/på for hele økta (0015). Bare læreren.
export const POST = guarded(async (req, ctx) => {
  const { id } = await ctx.params;
  if (!isUuid(id)) return fail(404, "not_found");
  const rl = limited(`voice:${id}`, 30);
  if (rl) return rl;
  const body = await parseBody(req, voiceBody);
  if (body instanceof Response) return body;
  const r = await rpc("set_voice", { p_session: id, p_host_token_hash: await sha256Hex(body.hostToken), p_on: body.on });
  if (r.ok) {
    defer(() => broadcast(channels.all(id), events.state), "voice");
    defer(() => liveNotify(id, "state"), "voice-live");
  }
  return respond(r);
});
