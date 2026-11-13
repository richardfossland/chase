import { guarded, respond, rpc } from "@/lib/server/rpc";
import { ipKey, limited, parseBody } from "@/lib/server/route";
import { libraryBody } from "@/lib/server/schemas";
import { sha256Hex } from "@/lib/server/tokens";

// Teacher library + share links (0010, PLAN §13 fase 6). The lærernøkkel
// travels in the POST body only; the database sees its SHA-256.
export const POST = guarded(async (req) => {
  const rl = limited(ipKey(req, "library"), 60);
  if (rl) return rl;
  const body = await parseBody(req, libraryBody);
  if (body instanceof Response) return body;
  const p_key_hash = await sha256Hex(body.teacherKey);
  switch (body.action) {
    case "get":
      return respond(await rpc("library_get", { p_key_hash }));
    case "save":
      return respond(
        await rpc("library_save", { p_key_hash, p_kind: body.kind, p_id: body.id ?? null, p_name: body.name, p_data: body.data ?? null }),
        (x) => ({ id: x.id }),
      );
    case "delete":
      return respond(await rpc("library_delete", { p_key_hash, p_kind: body.kind, p_id: body.id }));
    case "share":
      return respond(
        await rpc("share_create", { p_key_hash, p_plan_id: body.planId, p_area_id: body.areaId ?? null, p_name: body.name ?? null }),
        (x) => ({ code: x.code }),
      );
    case "revoke":
      return respond(await rpc("share_revoke", { p_key_hash, p_code: body.code }));
    case "copy":
      return respond(await rpc("share_copy", { p_key_hash, p_code: body.code }), (x) => ({ planId: x.plan_id, areaId: x.area_id ?? null }));
  }
});
