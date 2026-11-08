import { generateResumeCode, normalizeResumeCode } from "@/lib/codes";
import { isBlockedNickname, normalizeNickname } from "@/lib/nickname";
import { defer } from "@/lib/server/defer";
import { broadcast } from "@/lib/server/broadcast";
import { fail } from "@/lib/server/http";
import { channels, events } from "@/lib/realtime";
import { guarded, respond, rpc } from "@/lib/server/rpc";
import { ipKey, limited, parseBody } from "@/lib/server/route";
import { joinBody } from "@/lib/server/schemas";
import { newToken, sha256Hex } from "@/lib/server/tokens";

// A whole class shares one school NAT IP, so the IP limit is generous; the
// per-session player cap (60) is enforced in SQL.
export const POST = guarded(async (req) => {
  const rl = limited(ipKey(req, "join"), 150);
  if (rl) return rl;
  const body = await parseBody(req, joinBody);
  if (body instanceof Response) return body;
  const nickname = normalizeNickname(body.nickname);
  if (isBlockedNickname(nickname)) return fail(400, "bad_nickname");

  for (let attempt = 0; attempt < 3; attempt++) {
    const token = newToken();
    const resumeCode = generateResumeCode(randomUnit);
    const r = await rpc("join_session", {
      p_pin: body.pin,
      p_nickname: nickname,
      p_token_hash: await sha256Hex(token),
      p_resume_code_hash: await sha256Hex(normalizeResumeCode(resumeCode)),
      p_device_id: body.deviceId ?? null,
    });
    if (!r.ok && r.error === "code_clash") continue;
    if (r.ok) {
      const session = String(r.session_id);
      defer(() => broadcast(channels.host(session), events.roster), "join");
    }
    return respond(r, (x) => ({
      sessionId: x.session_id,
      playerId: x.player_id,
      nickname: x.nickname,
      status: x.status,
      token,
      resumeCode,
    }));
  }
  return fail(409, "code_clash");
});

function randomUnit() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] / 2 ** 32;
}
