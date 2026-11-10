import { fail, isUuid } from "@/lib/server/http";
import { guarded, respond, rpc } from "@/lib/server/rpc";
import { limited, parseBody } from "@/lib/server/route";
import { qrBody } from "@/lib/server/schemas";
import { sha256Hex } from "@/lib/server/tokens";

// Physical QR post scan or typed code (PLAN §3.1). Rate limited per player so
// codes cannot be guessed (32^5 codes, 20 tries a minute).
export const POST = guarded(async (req, ctx) => {
  const { id } = await ctx.params;
  if (!isUuid(id)) return fail(404, "not_found");
  const body = await parseBody(req, qrBody);
  if (body instanceof Response) return body;
  const rl = limited(`qr:${body.playerId}`, 20);
  if (rl) return rl;
  const r = await rpc("claim_qr", {
    p_player: body.playerId,
    p_token_hash: await sha256Hex(body.token),
    p_session: id,
    p_code: body.code,
  });
  return respond(r, (x) => ({
    n: x.n,
    value: x.value,
    first: x.first ?? false,
    already: x.already ?? false,
    newBadges: x.new_badges ?? [],
  }));
});
