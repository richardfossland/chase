import { rpc, respond, guarded } from "@/lib/server/rpc";
import { ipKey, limited, parseBody } from "@/lib/server/route";
import { createSessionBody } from "@/lib/server/schemas";
import { newToken, sha256Hex } from "@/lib/server/tokens";

// Teacher creates a session. Returns the raw host token ONCE; only its hash is stored.
export const POST = guarded(async (req) => {
  const rl = limited(ipKey(req, "sessions"), 10);
  if (rl) return rl;
  const body = await parseBody(req, createSessionBody);
  if (body instanceof Response) return body;

  const hostToken = newToken();
  const r = await rpc("create_session", {
    p_host_token_hash: await sha256Hex(hostToken),
    p_teacher_key_hash: body.teacherKey ? await sha256Hex(body.teacherKey) : null,
    p_boundary: body.boundary,
    p_assembly: body.assembly,
    p_forbidden: body.forbidden ?? null,
    p_plan: body.plan ?? { rounds: [{ mode: "free", duration_s: 600 }] },
    p_settings: body.settings ?? {},
    p_teacher_phone: body.teacherPhone ?? null,
    p_is_sim: body.sim === true && process.env.SIM_ENABLED === "1",
  });
  return respond(r, (x) => ({ sessionId: x.session_id, pin: x.pin, areaM2: x.area_m2, hostToken }));
});
