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
//   --bots N          number of bots (default 10, max 300)
//   --mix SPEC        e.g. "runner:50,sos:2,forbidden:2" (default: one of each special)
//   --minutes M       run time (default 2)
//   --seed S          scenario seed (default 42)
//   --rpc             send ticks straight to PostgREST (measures DB + PostgREST,
//                     not Next). Reads NEXT_PUBLIC_SUPABASE_URL and
//                     SUPABASE_SERVICE_ROLE_KEY from env or .env.development.local
//   --plan SPEC       playlist for --create, e.g. "posts:120,posts:120,posts:120"
//                     (default: one free round of --minutes)
//   --breather S      breather between rounds (default 60)
//   --countdown S     countdown before each round (default 10)
//   --qr N            physical QR cards in the session (default 0)
//   --until-done      stop as soon as the playlist is done (cap: --minutes)
//   --ceremony        with --until-done: run the ceremony (0006), bots vote «vil spille igjen»
//   --events S        with --create: automatic events every S s (0007); bots run to targets,
//                     use power-ups, press «Ferdig»; the teacher confirms missions
//   --quiz            with --create: a 4-question pack (0012); bots answer every question
//   --teams N         with --create: number of teams (0009); plan rounds flag:S, king:S and
//                     posts+team:S / free+team:S are team rounds. --assert then checks team
//                     sizes (≤ 1 apart), team points, flags taken, hill held, Lagpall
//   --end             end the session when done (with --create): roll call
//                     first, then force if someone is missing
//   --assert          exit 1 unless tick p95 < --p95 ms (default 50) and every
//                     expected alarm reached the teacher within 5 s; with --plan
//                     also: the playlist ran to the end on its own, posts were
//                     claimed and no post was claimed twice
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
const bots = Math.min(300, Number(args.bots ?? 10));
const seed = Number(args.seed ?? 42);
const p95Limit = Number(args.p95 ?? 50);

const sim = await loadSim();
const http = sim.httpTransport(base);

let pin = args.pin;
let hostToken;
let sessionId;
let ceremonyResult = null;
if (args.create) {
  const r = await http.post("/api/sessions", {
    boundary: square(59.9101, 10.7499, 150, 120),
    assembly: { type: "Point", coordinates: [10.7512, 59.91064] },
    forbidden: {
      type: "MultiPolygon",
      coordinates: [square(59.91115, 10.7518, 25, 20).coordinates],
    },
    sim: true,
    plan: {
      rounds: args.plan
        ? String(args.plan).split(",").map((x) => {
            // posts:360 | free:180 | convert:300 | swap:300 | fox:300 | flag:300 | king:300 | relay:300,
            // "+zone" adds the shrinking zone (posts+zone:300), "+team" plays it as teams (posts+team:300)
            const [kind, secs] = x.split(":");
            const [mode, layer] = kind.split("+");
            const zone = layer === "zone" ? { zone: true } : layer === "team" ? { team: true } : {};
            return mode === "convert" || mode === "swap" || mode === "fox"
              ? { mode: "tag", variant: mode, duration_s: Number(secs), ...zone }
              : { mode, duration_s: Number(secs), ...zone };
          })
        : [{ mode: "free", duration_s: Math.max(60, Math.round(minutes * 60)) }],
      countdown_s: Number(args.countdown ?? 10),
      breather_s: Number(args.breather ?? 60),
      qr_posts: Number(args.qr ?? 0),
      ...(args.events ? { event_every_s: Number(args.events) } : {}),
      ...(args.teams ? { teams: Number(args.teams) } : {}),
      ...(args.quiz ? { quiz: [
        { q: "Hovedstaden i Norge?", a: ["Bergen", "Oslo", "Tromsø"], c: 1 },
        { q: "Hva er 3 × 4?", a: ["12", "14"], c: 0 },
        { q: "Hvor mange bein har en edderkopp?", a: ["6", "8", "10", "12"], c: 1 },
        { q: "Hva heter Norges lengste elv?", a: ["Glomma", "Lågen"], c: 0 },
      ] } : {}),
    },
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
    `[${s.seconds}s] ${s.game.statuses.at(-1) ?? "?"} r${s.game.rounds}  ticks ${s.ticks}  p50 ${s.tickMs.p50} ms  p95 ${s.tickMs.p95} ms  ` +
      `alarmer ${s.alarms.seen}/${s.alarms.expected}  poster ${s.game.claims} (gull ${s.game.golden})  feil ${JSON.stringify(s.errors)}`,
  );
}, 10_000);

const deadline = Date.now() + minutes * 60_000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1000));
  // Give the bots ~40 s to walk to the assembly point after the last round.
  if (args["until-done"] && swarm.stats.game.playlistDone) {
    await new Promise((r) => setTimeout(r, 40_000));
    if (args.ceremony && hostToken) await runCeremony();
    break;
  }
}
swarm.stop();
clearInterval(progress);
// Give the teacher poll a last chance to see alarms that came due at the very end.
await new Promise((r) => setTimeout(r, 1500));

const summary = { bots: kinds.length, mix: count(kinds), rpc: !!args.rpc, ...sim.summarize(swarm.stats) };
if (ceremonyResult) summary.ceremony = ceremonyResult;
if (args.create && args.end) {
  // Teacher presses «Avslutt»: roll call guard first (PLAN §6), force only if needed.
  const e = await http.post(`/api/s/${sessionId}/end`, { hostToken });
  summary.end = e.status === 200 ? "ok" : `missing ${(e.data.missing ?? []).length}`;
  if (e.status !== 200) await http.post(`/api/s/${sessionId}/end`, { hostToken, force: true });
}
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
  if (args.plan && hostToken) {
    const want = String(args.plan).split(",").length;
    if (!summary.game.playlistDone) problems.push(`spillelista ble ikke ferdig (status ${summary.game.statuses.join("→")})`);
    if (summary.game.rounds !== want) problems.push(`${summary.game.rounds} av ${want} runder`);
    if (String(args.plan).includes("posts") && summary.game.claims === 0) problems.push("ingen poster tatt");
    if (summary.game.duplicateClaims > 0) problems.push(`${summary.game.duplicateClaims} poster tatt to ganger`);
    if (/convert|swap|fox/.test(String(args.plan))) {
      const fails = Object.entries(summary.game.catchFails)
        .filter(([k]) => k === "too_far" || k === "no_fix")
        .reduce((s, [, n]) => s + n, 0);
      const tries = summary.game.catches + fails;
      if (summary.game.catches === 0) problems.push("ingen fangster");
      else if (fails / tries > 0.1) problems.push(`${fails} av ${tries} fangstforsøk avvist (> 10 % tvist)`);
    }
  }
  if (args.ceremony) {
    const c = summary.ceremony;
    if (!c || c.error) problems.push(`seremoni feilet: ${c?.error ?? "kjørte ikke"}`);
    else {
      if (c.podiums === 0) problems.push("ingen paller");
      if (summary.game.bestCards < summary.bots - 2) problems.push(`bare ${summary.game.bestCards} av ${summary.bots} så «ditt beste»-kortet`);
      if ((c.again?.yes ?? 0) + (c.again?.no ?? 0) !== summary.game.votes) problems.push(`stemmer ${JSON.stringify(c.again)} ≠ ${summary.game.votes} sendt`);
    }
  }
  if (/\+zone/.test(String(args.plan)) && summary.game.zoneHits === 0) problems.push("ingen fikk sonebonus");
  if (args.events && hostToken) {
    const n = Object.values(summary.game.events).reduce((a, b) => a + b, 0);
    if (n === 0) problems.push("ingen hendelser startet");
    if (summary.game.sprintMax > 3) problems.push(`${summary.game.sprintMax} vinnere i én sprint (maks 3)`);
    if (n > 0 && summary.game.prizes === 0) problems.push("ingen fikk premie i hendelsene");
    if (summary.game.missionsDone > summary.game.missionsConfirmed) problems.push(`${summary.game.missionsDone - summary.game.missionsConfirmed} oppdrag ble aldri bekreftet`);
  }
  if (args.quiz && hostToken && /posts/.test(String(args.plan ?? ""))) {
    if (summary.game.quizAnswered === 0) problems.push("ingen svarte på spørsmål");
    else if (summary.game.quizRight === 0) problems.push("ingen riktige svar (fasit/valg ser feil ut)");
  }
  const teamPlan = /flag|king|relay|\+team/.test(String(args.plan ?? ""));
  if (teamPlan && hostToken) {
    const sz = summary.game.teamSizes;
    if (!sz) problems.push("lagene ble aldri fordelt");
    else {
      if (args.teams && sz.length !== Number(args.teams)) problems.push(`${sz.length} lag, ventet ${args.teams}`);
      if (Math.max(...sz) - Math.min(...sz) > 1) problems.push(`lagstørrelser ${sz.join("/")} (mer enn 1 i forskjell)`);
    }
    const pts = Object.values(summary.game.teamPoints);
    if (!pts.length || pts.every((x) => x === 0)) problems.push("ingen lagpoeng");
    if (/flag/.test(String(args.plan)) && summary.game.flagCaptures === 0) problems.push("ingen flagg tatt");
    if (/king/.test(String(args.plan)) && summary.game.hillHolds === 0) problems.push("ingen holdt haugen");
    if (/relay/.test(String(args.plan))) {
      if (summary.game.relayLegs === 0) problems.push("ingen stafett-etapper");
      // Bot views lag up to one tick, so hand-overs overlap: allow ~20 % (the exact cap is a SQL test).
      if (summary.game.relayBatonMax > summary.game.relayBatonCap + Math.max(1, Math.ceil(summary.game.relayBatonCap * 0.2))) problems.push(`${summary.game.relayBatonMax} pinner på ett lag (maks ${summary.game.relayBatonCap})`);
    }
    if (summary.game.msgsSent > 0 && summary.game.msgsSeen === 0) problems.push("lagbeskjeder kom aldri fram");
    if (args.ceremony && summary.ceremony && !summary.ceremony.error) {
      if (!summary.ceremony.cats?.includes("team")) problems.push("ingen Lagpall i seremonien");
      else if (summary.ceremony.teamEntries !== sz?.length) problems.push(`Lagpall viste ${summary.ceremony.teamEntries} lag`);
    }
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

// Teacher runs the ceremony (0006): start, reveal every podium, then the bots
// see their «ditt beste»-kort and vote. Result goes into summary.ceremony.
async function runCeremony() {
  const act = (action, payload) => http.post(`/api/s/${sessionId}/host`, { hostToken, action, payload });
  const st = await act("ceremony_start", { spread: true });
  if (st.status !== 200) {
    ceremonyResult = { error: `ceremony_start ${st.status} ${JSON.stringify(st.data)}` };
    return;
  }
  let snap = (await http.post(`/api/s/${sessionId}/snapshot`, { hostToken })).data;
  const total = snap.ceremony?.total ?? 0;
  const cats = [];
  let teamEntries = 0;
  console.log(`🏆 Seremoni: ${total} paller`);
  for (let i = 0; i <= total; i++) {
    await act("ceremony_next");
    snap = (await http.post(`/api/s/${sessionId}/snapshot`, { hostToken })).data;
    const last = snap.ceremony?.revealed?.at(-1);
    if (i < total && last) {
      cats.push(last.cat);
      if (last.cat === "team") teamEntries = last.entries.length;
      console.log(`   ${last.cat}: ${last.entries.map((e) => `${e.place}. ${e.nickname}${e.value !== null ? ` (${e.value})` : ""}`).join("  ")}`);
    }
  }
  await act("vote_again", { yes: true });
  await new Promise((r) => setTimeout(r, 8000));   // bots tick, see their card, vote
  snap = (await http.post(`/api/s/${sessionId}/snapshot`, { hostToken })).data;
  const onPodium = new Set((snap.ceremony?.revealed ?? []).flatMap((p) => p.entries.map((e) => e.nickname)));
  ceremonyResult = { podiums: total, step: snap.ceremony?.step, onPodium: onPodium.size, again: snap.ceremony?.again, cats, teamEntries };
}

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
