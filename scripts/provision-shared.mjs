// Provision Chase INTO the shared Supabase project (the SundayChess project,
// which also hosts quiz + turnering), in its own `chase` schema:
//   1. apply every supabase/migrations/*.sql in order (they are idempotent),
//   2. expose `chase` to PostgREST (additive — other schemas are kept),
//   3. write .env.local with URL + keys.
//
//   SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/provision-shared.mjs
//
// Revoke the access token afterwards. Never commit .env.local.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const REF = process.env.PROJECT_REF || "fwbfhwxgkjelcutwajza"; // shared SundayChess project
const BASE = "https://api.supabase.com/v1";
const SCHEMA = "chase";

if (!TOKEN) {
  console.error("Set SUPABASE_ACCESS_TOKEN (sbp_…).");
  process.exit(1);
}
const H = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

async function api(path, init) {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init?.headers || {}) } });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (!res.ok) throw new Error(`${res.status} ${path}: ${text}`);
  return json;
}
const query = (sql) =>
  api(`/projects/${REF}/database/query`, { method: "POST", body: JSON.stringify({ query: sql }) });

async function main() {
  console.log(`Target project: ${REF} (shared)`);

  // 1. Migrations, in filename order.
  const dir = new URL("../supabase/migrations/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    console.log(`Applying ${file} …`);
    await query(readFileSync(new URL(file, dir), "utf8"));
  }
  const [health] = await query("select chase.health() as h");
  console.log("  health:", JSON.stringify(health?.h ?? health));

  // 2. Expose the schema to PostgREST (service role only — anon has no USAGE).
  console.log("Exposing schema to PostgREST …");
  const cfg = await api(`/projects/${REF}/postgrest`);
  const schemas = String(cfg.db_schema || "public, graphql_public")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!schemas.includes(SCHEMA)) schemas.push(SCHEMA);
  await api(`/projects/${REF}/postgrest`, {
    method: "PATCH",
    body: JSON.stringify({ db_schema: schemas.join(", ") }),
  });
  console.log(`  db_schema = ${schemas.join(", ")}`);

  // 3. Keys (legacy or new naming).
  const keys = await api(`/projects/${REF}/api-keys`);
  const keyVal = (k) => k?.api_key ?? k?.secret ?? k?.value;
  const anon = keyVal(keys.find((k) => k.name === "anon" || k.type === "publishable" || k.name === "publishable"));
  const service = keyVal(keys.find((k) => k.name === "service_role" || k.type === "secret" || k.name === "secret"));
  if (!anon || !service) console.warn("⚠ key autodetect failed — fill .env.local by hand.");

  writeFileSync(
    new URL("../.env.local", import.meta.url),
    [
      `NEXT_PUBLIC_SUPABASE_URL=https://${REF}.supabase.co`,
      `NEXT_PUBLIC_SUPABASE_ANON_KEY=${anon ?? ""}`,
      `SUPABASE_SERVICE_ROLE_KEY=${service ?? ""}`,
      `NEXT_PUBLIC_BASE_URL=https://chase.sundaysuite.app`,
      "",
    ].join("\n"),
  );
  console.log("\n✓ Wrote .env.local. PostgREST reload takes a few seconds.");
  console.log("⚠ Revoke SUPABASE_ACCESS_TOKEN when done.");
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
