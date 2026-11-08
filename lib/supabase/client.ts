"use client";

import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";

// Browser Supabase client (anon key), used ONLY for Realtime broadcast/presence.
// All authoritative reads/writes go through the server API routes; anon has no
// access to the `chase` schema at all (ADR-006). One shared instance per tab.
let client: SupabaseClient | null = null;

export function createClient(): SupabaseClient {
  client ??= createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  return client;
}
