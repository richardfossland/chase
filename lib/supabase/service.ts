import "server-only";

import { createClient } from "@supabase/supabase-js";

/** Service-role Supabase client — SERVER ONLY. Bypasses RLS (which is deny-all
 * for every `chase` table), so it must never reach client code; the
 * `server-only` guard enforces that at build time. Every API route uses this. */
export function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Supabase env missing: set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  }
  // Shared project (SundayChess owns `public`, quiz owns `quiz`, …): default
  // every query and RPC to the dedicated `chase` schema.
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: "chase" },
  });
}
