#!/usr/bin/env node
// Headless GPS simulator / load test (PLAN §11.3). Same behaviour + driver code
// as /dev/sim (lib/sim/*), bundled on the fly with esbuild.
//
//   node scripts/sim.mjs --create --bots 60 --minutes 20 --seed 42 --assert
//   node scripts/sim.mjs --pin 123456 --bots 10 --minutes 5
//
// Options
//   --base URL        Chase base URL (default http://localhost:3120)
//   --pin PIN         join an existing session (e.g. one made in /ny)
//   --create          create a sim session (needs SIM_ENABLED=1 on the server),
//                     start it, and check alarm latency as the teacher
//   --bots N          number of bots (default 10, max 60)
//   --mix SPEC        e.g. "runner:50,sos:2,forbidden:2" (default: one of each special)
//   --minutes M       run time (default 2)
//   --seed S          scenario seed (default 42)
//   --rpc             send ticks straight to PostgREST (measures DB + PostgREST,
//                     not Next). Reads NEXT_PUBLIC_SUPABASE_URL and
//                     SUPABASE_SERVICE_ROLE_KEY from env or .env.development.local
//   --end             end the session (force) when done (with --create)
//   --assert          exit 1 unless tick p95 < --p95 ms (default 50) and every
//                     expected alarm reached the teacher within 5 s
//   --json FILE       write the summary as JSON
//
// Positions are generated, never read from real pupils, and never logged.

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const args = parseArgs(process.argv.slice(2));
const base = args.base ?? "http://localhost:3120";
const minutes = Number(args.minutes ?? 2);
const bots = Math.min(60, Number(args.bots ?? 10));
const seed = Number(args.seed ?? 42);
const p95Limit = Number(args.p95 ?? 50);

const sim = await loadSim();
const http = sim.httpTransport(base);

let pin = args.pin;
let hostToken;
let sessionId;
if (args.create) {
  const r = await http.post("/api/sessions", {
    boundary: square(59.9101, 10.7499, 150, 120),
    assembly: { type: "Point", coordinates: [10.7512, 59.91064] },
    forbidden: {
      type: "MultiPolygon",
      coordinates: [square(59.91115, 10.7518, 25, 20).coordinates],
    },
    sim: true,
  });
  if (r.status !== 200) fail(`create_session: ${r.status} ${JSON.stringify(r.data)}`);
  ({ pin, hostToken, sessionId } = r.data);
  console.log(`Sim-økt ${sessionId}  PIN ${pin}`);
  console.log(`Lærertoken (bare lokalt): ${hostToken}`);
}
if (!pin) fail("Bruk --pin PIN eller --create");

const kinds = args.mix ? sim.parseMix(args.mix) : sim.defaultMix(bots);
const transport = args.rpc ? rpcTransport(http) : http;
const swarm = sim.startSwarm({
  transport,
  pin,
  kinds,
  seed,
  hostToken,
  sosAfterS: 45,
  dropoutAfterS: 30,
  dropoutForS: 90,
  onLog: (l) => console.log(l),
});
const { sessionId: sid } = await swarm.ready;
sessionId = sid;
if (args.create) {
  const r = await http.post(`/api/s/${sessionId}/host`, { hostToken, action: "start" });
  if (r.status !== 200) fail(`start: ${r.status}`);
  console.log("Økta er startet.");
}

const progress = setInterval(() => {
  const s = sim.summarize(swarm.stats);
  console.log(
    `[${s.seconds}s] ticks ${s.ticks}  p50 ${s.tickMs.p50} ms  p95 ${s.tickMs.p95} ms  ` +
      `alarmer ${s.alarms.seen}/${s.alarms.expected}  feil ${JSON.stringify(s.errors)}`,
  );
}, 10_000);

await new Promise((r) => setTimeout(r, minutes * 60_000));
swarm.stop();
clearInterval(progress);
// Give the teacher poll a last chance to see alarms that came due at the very end.
await new Promise((r) => setTimeout(r, 1500));

const summary = { bots: kinds.length, mix: count(kinds), rpc: !!args.rpc, ...sim.summarize(swarm.stats) };
if (args.create && args.end) await http.post(`/api/s/${sessionId}/end`, { hostToken, force: true });
console.log(JSON.stringify(summary, null, 2));
if (args.json) writeFileSync(args.json, JSON.stringify(summary, null, 2));

if (args.assert) {
  const problems = [];
  if (summary.tickMs.p95 >= p95Limit) problems.push(`tick p95 ${summary.tickMs.p95} ms ≥ ${p95Limit} ms`);
  if (hostToken) {
    if (summary.alarms.maxDelayS !== null && summary.alarms.maxDelayS > 5) problems.push(`alarm brukte ${summary.alarms.maxDelayS} s (> 5 s)`);
    const overdue = swarm.stats.alarms.filter((a) => a.seenAt === null && Date.now() - a.expectedAt > 5000);
    if (overdue.length) problems.push(`${overdue.length} alarm(er) kom aldri fram: ${overdue.map((a) => a.kind).join(", ")}`);
  }
  const errs = Object.entries(summary.errors).filter(([k]) => !k.includes("stale"));
  if (errs.length) problems.push(`feil: ${JSON.stringify(Object.fromEntries(errs))}`);
  if (problems.length) {
    console.error("✗ " + problems.join("\n✗ "));
    process.exit(1);
  }
  console.log("✓ Alle krav oppfylt");
}
process.exit(0);

// ───────────────────────── helpers ─────────────────────────

async function loadSim() {
  const out = join(mkdtempSync(join(tmpdir(), "chase-sim-")), "sim.mjs");
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

function rpcTransport(http) {
  const env = { ...readEnv(join(ROOT, ".env.development.local")), ...process.env };
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) fail("--rpc trenger NEXT_PUBLIC_SUPABASE_URL og SUPABASE_SERVICE_ROLE_KEY");
  const hashes = new Map();
  return {
    post: http.post,
    async tick(sessionId, p, fix) {
      if (!hashes.has(p.playerId)) hashes.set(p.playerId, createHash("sha256").update(p.token).digest("hex"));
      try {
        const res = await fetch(`${url}/rest/v1/rpc/tick`, {
          method: "POST",
          headers: {
            apikey: key,
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
            "Content-Profile": "chase",
          },
          body: JSON.stringify({
            p_player: p.playerId,
            p_token_hash: hashes.get(p.playerId),
            p_lat: fix.lat,
            p_lng: fix.lng,
            p_acc: fix.acc,
            p_speed: fix.speed,
            p_client_ts: new Date().toISOString(),
            p_session: sessionId,
          }),
        });
        const data = await res.json();
        return { status: res.ok && data.ok ? 200 : res.ok ? 409 : res.status, data };
      } catch {
        return { status: 0, data: { error: "network" } };
      }
    },
  };
}

function square(lat, lng, wM, hM) {
  const dLat = hM / 111_320;
  const dLng = wM / (111_320 * Math.cos((lat * Math.PI) / 180));
  return {
    type: "Polygon",
    coordinates: [[[lng, lat], [lng + dLng, lat], [lng + dLng, lat + dLat], [lng, lat + dLat], [lng, lat]]],
  };
}

function readEnv(file) {
  if (!existsSync(file)) return {};
  return Object.fromEntries(
    readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) o[k] = true;
    else {
      o[k] = next;
      i++;
    }
  }
  return o;
}

function count(xs) {
  return xs.reduce((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}
