import path from "node:path";
import type { NextConfig } from "next";
import { securityHeaders } from "./lib/security/headers";

const nextConfig: NextConfig = {
  env: { NEXT_PUBLIC_BUILD_ID: (process.env.GITHUB_SHA ?? process.env.NEXT_PUBLIC_BUILD_ID ?? "").slice(0, 8) },
  // Sikkerhetsheadere på alt Next svarer på (sider + API). Statiske filer fra
  // Cloudflare Assets går utenom Next og dekkes av public/_headers.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders({
          supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
          liveWsBase: process.env.NEXT_PUBLIC_LIVE_WS_BASE,
          dev: process.env.NODE_ENV !== "production",
        }),
      },
    ];
  },
  // Pin the workspace root: a stray parent lockfile (~/package-lock.json) would
  // otherwise be auto-selected and break output tracing / env resolution.
  turbopack: {
    root: path.join(__dirname),
  },
  experimental: {
    // Next 16 defaults `useTypeScriptCli` to true: it type-checks the build by
    // spawning `packageJson.bin.tsc` from whatever package answers to the name
    // `typescript`. We deliberately point that name at the TS 6 compat package
    // (see package.json / docs/DECISIONS.md ADR-004), and that package names
    // its binary `tsc6` — so `bin.tsc` is undefined and Next aborts the build
    // with "you do not have the required package(s) installed".
    //
    // Switching to the in-process API path fixes it: Next then needs
    // `typescript/lib/typescript.js`, which the compat package does ship, and
    // which is the TS 6.0 API Next 16 asks for by name (its own auto-install
    // hint is `typescript@^6.0.0`).
    //
    // Consequence: Next's build-time type check runs on TS 6 while the
    // authoritative gate — `npm run typecheck` / `npm run check` — runs the
    // real TS 7 compiler from `@typescript/native`. Nothing is unchecked; one
    // check is simply a version behind. Both collapse back to a single TS 7
    // when typescript-eslint#10940 lets `typescript` hold TS 7 again.
    useTypeScriptCli: false,
  },
};

export default nextConfig;
