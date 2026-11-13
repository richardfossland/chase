import { channels, events } from "@/lib/realtime";
import { broadcast } from "@/lib/server/broadcast";
import { defer } from "@/lib/server/defer";
import { fail, isUuid } from "@/lib/server/http";
import { guarded, respond, rpc } from "@/lib/server/rpc";
import { limited, parseBody } from "@/lib/server/route";
import { eventBody } from "@/lib/server/schemas";
import { sha256Hex } from "@/lib/server/tokens";

// Phase 4 (0007): use a power-up, or «Ferdig» on a mission (the teacher
// confirms). Phase 5 (0009): a quick team message. The server decides
// whether it fits right now. No broadcast for team messages: teammates get
// them with their next tick (positions never go over Realtime).
export const POST = guarded(async (req, ctx) => {
  const { id } = await ctx.params;
  if (!isUuid(id)) return fail(404, "not_found");
  const body = await parseBody(req, eventBody);
  if (body instanceof Response) return body;
  const rl = limited(`event:${body.playerId}`, 20);
  if (rl) return rl;
  const auth = { p_player: body.playerId, p_token_hash: await sha256Hex(body.token), p_session: id };
  if (body.action === "powerup") {
    const r = await rpc("use_powerup", { ...auth, p_kind: body.kind });
    return respond(r, (x) => ({ kind: x.kind, until: x.until ?? null, newBadges: x.new_badges ?? [] }));
  }
  if (body.action === "quiz") {
    const r = await rpc("quiz_answer", { ...auth, p_choice: body.choice });
    return respond(r, (x) => ({ right: x.right === true, answer: x.answer ?? null, points: x.points ?? 0, newBadges: x.new_badges ?? [] }));
  }
  if (body.action === "team_msg") {
    const r = await rpc("team_msg", { ...auth, p_kind: body.kind });
    return respond(r, (x) => ({ kind: x.kind, at: x.at }));
  }
  const r = await rpc("mission_done", auth);
  // The teacher's list of «Ferdig» to confirm changed.
  if (r.ok) defer(() => broadcast(channels.host(id), events.roster), "mission");
  return respond(r, (x) => ({ state: x.state ?? null }));
});
