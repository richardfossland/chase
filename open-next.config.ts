import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// OpenNext → Cloudflare Workers adapter. No ISR/edge cache: all state lives in
// Supabase. Deployed at chase.sundaysuite.app.
export default defineCloudflareConfig();
