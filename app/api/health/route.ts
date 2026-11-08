import { createServiceClient } from "@/lib/supabase/service";
import { fail, ok } from "@/lib/server/http";

// Liveness + DB reachability. Calls chase.health() (migration 0001), which
// returns only static facts (schema + PostGIS version) — never game data.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { data, error } = await createServiceClient().rpc("health");
    if (error) return fail(503, "db_unreachable");
    return ok({ ok: true, db: data });
  } catch {
    return fail(503, "db_not_configured");
  }
}
