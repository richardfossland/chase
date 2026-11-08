import { normalizeResumeCode } from "@/lib/codes";
import { guarded, respond, rpc } from "@/lib/server/rpc";
import { ipKey, limited, parseBody } from "@/lib/server/route";
import { resumeBody } from "@/lib/server/schemas";
import { newToken, sha256Hex } from "@/lib/server/tokens";

// PIN + resume code → fresh token (the old device stops working).
export const POST = guarded(async (req) => {
  const rl = limited(ipKey(req, "resume"), 30);
  if (rl) return rl;
  const body = await parseBody(req, resumeBody);
  if (body instanceof Response) return body;
  const token = newToken();
  const r = await rpc("resume_player", {
    p_pin: body.pin,
    p_resume_code_hash: await sha256Hex(normalizeResumeCode(body.resumeCode)),
    p_new_token_hash: await sha256Hex(token),
  });
  return respond(r, (x) => ({ sessionId: x.session_id, playerId: x.player_id, nickname: x.nickname, token }));
});
