import { rpc, respond, guarded } from "@/lib/server/rpc";
import { clientIp } from "@/lib/server/http";
import { demoKeys, DEMO_MAX_ACTIVE, DEMO_PER_HOUR, sessionFlags } from "@/lib/server/demo";
import { ipKey, limited, parseBody } from "@/lib/server/route";
import { createSessionBody } from "@/lib/server/schemas";
import { newToken, sha256Hex } from "@/lib/server/tokens";
import { DEFAULT_PLAN } from "@/lib/rules/game";

// Teacher creates a session. Returns the raw host token ONCE; only its hash is stored.
export const POST = guarded(async (req) => {
  // Alle økter, også demo og sim, teller i denne IP-grensa: demo gir ingen ekstra kvote.
  const rl = limited(ipKey(req, "sessions"), 10);
  if (rl) return rl;
  const body = await parseBody(req, createSessionBody);
  if (body instanceof Response) return body;

  // `sim` krever SIM_ENABLED=1 eller riktig x-sim-key (Worker-secret SIM_KEY). `demo` er åpen, men går gjennom demo_gate.
  const flags = sessionFlags(body, process.env, req.headers.get("x-sim-key"));
  if (flags.demo) {
    const gate = await rpc("demo_gate", {
      p_keys: await demoKeys(clientIp(req), body.teacherKey),
      p_limit: DEMO_PER_HOUR,
      p_max_active: DEMO_MAX_ACTIVE,
    });
    if (!gate.ok) return respond(gate, () => ({}));
  }

  const hostToken = newToken();
  const r = await rpc("create_session", {
    p_host_token_hash: await sha256Hex(hostToken),
    p_teacher_key_hash: body.teacherKey ? await sha256Hex(body.teacherKey) : null,
    p_boundary: body.boundary,
    p_assembly: body.assembly,
    p_forbidden: body.forbidden ?? null,
    p_plan: body.plan ?? DEFAULT_PLAN,
    p_settings: flags.demo ? { ...(body.settings ?? {}), demo: true } : (body.settings ?? {}),
    p_teacher_phone: body.teacherPhone ?? null,
    p_is_sim: flags.isSim,
  });
  return respond(r, (x) => ({ sessionId: x.session_id, pin: x.pin, areaM2: x.area_m2, hostToken }));
});
