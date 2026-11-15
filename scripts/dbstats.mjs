#!/usr/bin/env node
// Read-only DB counters around a load test (Durable Objects stage 1 gate).
//
//   node scripts/dbstats.mjs snapshot --out before.json [--project <ref>]
//   ... run scripts/sim.mjs ...
//   node scripts/dbstats.mjs snapshot --out after.json  [--project <ref>]
//   node scripts/dbstats.mjs diff before.json after.json
//
// Connection (first match wins, secrets are never printed):
//   --project <ref> + SUPABASE_ACCESS_TOKEN   Supabase Management API
//                                             POST /v1/projects/<ref>/database/query
//   DATABASE_URL                              shells out to psql (no pg driver in deps),
//                                             with default_transaction_read_only=on
// Captures pg_stat_database (this database), pg_stat_user_functions for schema chase
// (needs track_functions = pl|all) and the top pg_stat_statements rows mentioning chase
// (skipped when the extension is not readable). Only SELECTs are ever sent.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const [cmd, ...rest] = process.argv.slice(2);
const sim = await loadSim();
const args = sim.parseArgs(rest);
const positional = rest.filter((a) => !a.startsWith("--")).slice(0, 2); // diff a.json b.json come first

if (cmd === "snapshot") {
  if (!args.out || args.out === true) fail("Bruk: snapshot --out fil.json [--project ref]");
  const q = connect();
  const [db] = await q(
    "select numbackends, xact_commit, xact_rollback, blks_read, blks_hit, tup_returned, tup_fetched, tup_inserted, tup_updated, tup_deleted, conflicts, deadlocks from pg_stat_database where datname = current_database()",
  );
  if (!db) fail("pg_stat_database ga ingen rad");
  const functions = await q(
    "select schemaname || '.' || funcname as name, calls::float8 as calls, total_time, self_time from pg_stat_user_functions where schemaname = 'chase'",
  );
  if (!functions.length) console.error("Merk: ingen chase-funksjoner i pg_stat_user_functions (track_functions er kanskje av).");
  let statements = null;
  try {
    statements = await q(
      "select left(query, 160) as query, calls::float8 as calls, total_exec_time, rows::float8 as rows from pg_stat_statements where query ilike '%chase.%' order by total_exec_time desc limit 25",
    );
  } catch {
    console.error("Merk: pg_stat_statements er ikke lesbar, hoppet over.");
  }
  const snap = { takenAt: new Date().toISOString(), database: Object.fromEntries(Object.entries(db).map(([k, v]) => [k, Number(v)])), functions, statements };
  writeFileSync(args.out, JSON.stringify(snap, null, 2));
  console.log(`Snapshot ${snap.takenAt}: ${snap.database.xact_commit} commits, ${functions.length} funksjoner${statements ? `, ${statements.length} spørringer` : ""} → ${args.out}`);
} else if (cmd === "diff") {
  const [a, b] = positional;
  if (!a || !b) fail("Bruk: diff a.json b.json");
  const d = sim.diffSnapshots(JSON.parse(readFileSync(a, "utf8")), JSON.parse(readFileSync(b, "utf8")));
  console.log(`Tid mellom snapshots: ${d.seconds} s`);
  console.log(`Transaksjoner: ${d.transactions}  (${d.tps} /s)  rollback ${d.rollbackPct} %  cache-treff ${d.cacheHitPct ?? "-"} %`);
  console.log("Per sekund: " + Object.entries(d.perSec).map(([k, v]) => `${k} ${v}`).join("  "));
  if (d.delta.deadlocks) console.log(`⚠ deadlocks: ${d.delta.deadlocks}`);
  console.log("\nchase-funksjoner (etter total tid):");
  for (const f of d.functions.slice(0, 15)) console.log(`  ${f.name.padEnd(36)} ${String(f.calls).padStart(8)} kall  ${String(f.callsPerSec).padStart(8)} /s  snitt ${f.avgMs} ms  total ${f.totalMs} ms  selv ${f.selfMs} ms`);
  if (!d.functions.length) console.log("  (ingen kall, eller track_functions er av)");
  if (d.statements) {
    console.log("\npg_stat_statements (etter total tid):");
    for (const s of d.statements.slice(0, 10)) console.log(`  ${String(s.calls).padStart(8)} kall  snitt ${s.avgMs} ms  ${s.query.replace(/\s+/g, " ").slice(0, 100)}`);
  }
  if (args.json) writeFileSync(args.json, JSON.stringify(d, null, 2));
} else {
  fail("Bruk: dbstats.mjs snapshot --out f.json | diff a.json b.json");
}

function connect() {
  if (args.project && process.env.SUPABASE_ACCESS_TOKEN) {
    const ref = String(args.project);
    if (!/^[a-z0-9]{20}$/.test(ref)) fail("--project må være prosjekt-ref (20 tegn)");
    return async (sql) => {
      const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: sql }),
      });
      if (!res.ok) throw new Error(`Management API ${res.status}`);
      return await res.json();
    };
  }
  if (process.env.DATABASE_URL) {
    return async (sql) => {
      try {
        const out = execFileSync(
          "psql",
          [process.env.DATABASE_URL, "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", `select coalesce(json_agg(t), '[]'::json) from (${sql}) t`],
          { encoding: "utf8", env: { ...process.env, PGOPTIONS: "-c default_transaction_read_only=on" }, stdio: ["ignore", "pipe", "pipe"] },
        );
        return JSON.parse(out.trim());
      } catch (e) {
        // Never echo the command line (it holds the URL).
        throw new Error(`psql feilet: ${String(e.stderr ?? "").split("\n")[0].replace(/postgres(ql)?:\/\/\S+/g, "<url>")}`);
      }
    };
  }
  fail("Sett DATABASE_URL (psql), eller SUPABASE_ACCESS_TOKEN + --project <ref>");
}

async function loadSim() {
  const out = join(mkdtempSync(join(tmpdir(), "chase-dbstats-")), "sim.mjs");
  await build({
    entryPoints: [join(ROOT, "lib/sim/index.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: out,
    alias: { "@": ROOT.replace(/\/$/, "") },
    logLevel: "warning",
  });
  return import(pathToFileURL(out).href);
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}
