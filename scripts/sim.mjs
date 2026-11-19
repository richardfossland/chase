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
//   --create          create a sim session (needs SIM_ENABLED=1 on the server, or env CHASE_SIM_KEY
//                     = the Worker secret SIM_KEY so prod marks the session is_sim),
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
// WebSocket transport (Durable Objects stage 1, ADR-031)
//   --transport ws|http  http (default) = today's POST /tick. ws = each bot opens a
//                     socket at <live-ws><live.path> (live.path from /me; the server must
//                     run LIVE_TRANSPORT=ws, else the sim stops). 10 % of the bots drop
//                     their socket every 60–120 s (iPhone), the teacher gets a host socket.
//   --live-ws URL     ws base for the sockets (default: --base with http→ws).
//                     Local: ws://127.0.0.1:8787 (wrangler dev, `npm run live:dev`)
//   --sessions N      N independent sessions at once (needs --create); seed + k per session
//   --kill-at S       at S s close ALL sockets at once (chase-live redeploy); reports the
//                     time until ≥ 95 % are back on ws and alarms missed meanwhile
//   --no-urgent       bots never flag a fix urgent (the phone before ADR-038), for before/after runs
//   --live-stats URL  fetch <URL>/live/s/<id>/stats per session at the end (internal,
//                     local wrangler port only: http://127.0.0.1:8787)
//   --assert (ws)     adds: 0 5xx, alarm max < 5 s and p95 < 3 s, fix→view p95 < 2 s and
//                     p99 < 3 s, recovery after --kill-at within 10 s
//
// Positions are generated, never read from real pupils, and never logged.

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const sim = await loadSim();
const args = sim.parseArgs(process.argv.slice(2));
const base = args.base ?? "http://localhost:3120";
const minutes = Number(args.minutes ?? 2);
const bots = Math.min(300, Number(args.bots ?? 10));
const seed = Number(args.seed ?? 42);
const p95Limit = Number(args.p95 ?? 50);
let cfg;
try {
  cfg = sim.parseSimConfig(args);
} catch (e) {
  fail(e.message);
}
if (cfg.sessions > 1 && !args.create) fail("--sessions N krever --create (hver økt trenger sin egen PIN)");
// Prod: SIM_KEY (Worker-secret) i env CHASE_SIM_KEY merker --create-øktene is_sim. Uten nøkkel ignoreres `sim: true` i prod.
const http = sim.httpTransport(base, process.env.CHASE_SIM_KEY ? { "x-sim-key": process.env.CHASE_SIM_KEY } : undefined);
const wsBase = cfg.liveWs ?? sim.toWsBase(base);

const runs = await Promise.all(Array.from({ length: cfg.sessions }, (_, k) => runSession(k)));
if (runs.some((r) => !r)) process.exit(1);

const problems = [];
const summaries = runs.map((r) => r.summary);
const sessionLabel = (r) => (runs.length > 1 ? `økt ${r.k + 1}: ` : "");
let output;
if (runs.length === 1) {
  output = runs[0].summary;
} else {
  const all = runs.map((r) => r.swarm.stats);
  const lat = all.flatMap((x) => x.latencies);
  const agg = { sessions: runs.length, transport: cfg.transport, bots: summaries.reduce((n, x) => n + x.bots, 0) };
  agg.ticks = summaries.reduce((n, x) => n + x.ticks, 0);
  agg.tickMs = { p50: sim.percentile(lat, 50), p95: sim.percentile(lat, 95), p99: sim.percentile(lat, 99), max: lat.length ? Math.max(...lat) : 0 };
  if (cfg.transport === "ws") {
    const g = sim.aggregateGate(all, cfg.killAtS);
    const fv = all.flatMap((x) => x.ws?.fixView ?? []);
    agg.fixView = { n: fv.length, p50: sim.percentile(fv, 50), p95: sim.percentile(fv, 95), p99: sim.percentile(fv, 99), max: fv.length ? Math.max(...fv) : 0 };
    agg.alarms = { maxS: g.alarmMaxS, p95S: g.alarmP95S };
    agg.reconnects = summaries.reduce((n, x) => n + x.ws.reconnects, 0);
    if (cfg.killAtS !== null) agg.kill = { recoveryS: g.recoveryS, missedAlarms: g.missedAlarmsAfterKill };
  }
  output = { aggregate: agg, sessions: summaries };
}
console.log(JSON.stringify(output, null, 2));
if (args.json) writeFileSync(args.json, JSON.stringify(output, null, 2));
if (runs.length > 1 || cfg.transport === "ws") printTable(runs);

if (args.assert) {
  for (const r of runs) for (const pr of r.problems) problems.push(sessionLabel(r) + pr);
  if (cfg.transport === "ws") {
    const g = sim.aggregateGate(runs.map((r) => r.swarm.stats), cfg.killAtS);
    for (const pr of sim.wsGateProblems(g)) problems.push(pr);
  }
  if (problems.length) {
    console.error("✗ " + problems.join("\n✗ "));
    process.exit(1);
  }
  console.log("✓ Alle krav oppfylt");
}
process.exit(0);

// ───────────────────────── one session ─────────────────────────

async function runSession(k) {
  const tag = cfg.sessions > 1 ? `[økt ${k + 1}] ` : "";
  const out = (l) => console.log(tag + l);
  let pin = args.pin;
  let hostToken;
  let sessionId;
  let ceremonyResult = null;
  const seedK = seed + k;
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
              // posts:360 | free:180 | convert:300 | swap:300 | fox:300 | hide:180 (Gjemsel, 75 s forsprang) | flag:300 | king:300 | relay:300 | scoreo:180,
              // "+zone" adds the shrinking zone (posts+zone:300), "+team" plays it as teams (posts+team:300),
              // "+practice" makes it a prøverunde (posts+practice:60, convert+practice:60); scoreo has a 120 s return window on top
              const [kind, secs] = x.split(":");
              const [mode, layer] = kind.split("+");
              const zone = layer === "zone" ? { zone: true } : layer === "team" ? { team: true } : layer === "practice" ? { practice: true } : {};
              return mode === "convert" || mode === "swap" || mode === "fox" || mode === "hide"
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
    out(`Sim-økt ${sessionId}  PIN ${pin}`);
    out(`Lærertoken (bare lokalt): ${hostToken}`);
  }
  if (!pin) fail("Bruk --pin PIN eller --create");

  const kinds = args.mix ? sim.parseMix(args.mix) : sim.defaultMix(bots);
  const transport = args.rpc ? rpcTransport(http) : http;
  const swarm = sim.startSwarm({
    transport,
    pin,
    kinds,
    seed: seedK,
      ws: cfg.transport === "ws" ? { base: wsBase } : undefined,
    urgent: !args["no-urgent"],
    hostToken,
    sosAfterS: 45,
    dropoutAfterS: 30,
    dropoutForS: 90,
    onLog: out,
  });
  let sid;
  try {
    ({ sessionId: sid } = await swarm.ready);
  } catch (e) {
    swarm.stop();
    fail(tag + e.message);
  }
  sessionId = sid;
  if (args.create) {
    const r = await http.post(`/api/s/${sessionId}/host`, { hostToken, action: "start" });
    if (r.status !== 200) fail(`start: ${r.status}`);
    out("Økta er startet.");
  }
  if (cfg.killAtS !== null) {
    setTimeout(() => {
      out(`☠ --kill-at: lukker alle sockets (${swarm.stats.ws.connectedNow} tilkoblet)`);
      swarm.kill();
    }, cfg.killAtS * 1000);
  }

  const progress = setInterval(() => {
    const s = sim.summarize(swarm.stats);
    out(
      `[${s.seconds}s] ${s.game.statuses.at(-1) ?? "?"} r${s.game.rounds}  ticks ${s.ticks}  p50 ${s.tickMs.p50} ms  p95 ${s.tickMs.p95} ms  ` +
        (s.ws ? `ws ${swarm.stats.ws.connectedNow}/${swarm.players.length}  fix→view p95 ${s.ws.fixView.p95} ms  reconnects ${s.ws.reconnects}  ` : "") +
        `alarmer ${s.alarms.seen}/${s.alarms.expected}  poster ${s.game.claims} (gull ${s.game.golden})  feil ${JSON.stringify(s.errors)}`,
    );
  }, 10_000);

  const deadline = Date.now() + minutes * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    // Give the bots ~40 s to walk to the assembly point after the last round.
    if (args["until-done"] && swarm.stats.game.playlistDone) {
      await new Promise((r) => setTimeout(r, 40_000));
      if (args.ceremony && hostToken) ceremonyResult = await runCeremony(http, sessionId, hostToken);
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
  summary.sessionId = sessionId;
  if (cfg.liveStats) summary.roomStats = await fetchRoomStats(cfg.liveStats, sessionId);

  const problems = [];
  if (args.assert) {
    // ws: fix→view includes waiting for the room's ~1 s batched write; the ws gate checks it instead.
    if (cfg.transport !== "ws" && summary.tickMs.p95 >= p95Limit) problems.push(`tick p95 ${summary.tickMs.p95} ms ≥ ${p95Limit} ms`);
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
    if (/scoreo/.test(String(args.plan)) && hostToken) {
      if (summary.game.claims === 0) problems.push("ingen poster tatt i poengorientering");
      if (summary.game.scoreoDup > 0) problems.push(`${summary.game.scoreoDup} poster tatt to ganger av samme elev`);
      if (summary.game.scoreoIn === 0) problems.push("ingen kom tilbake til møteplassen");
      if (summary.bots >= 10 && summary.game.scoreoLate === 0) problems.push("ingen fikk poengtrekk (noen boter skal komme for sent)");
      if (args.ceremony && summary.ceremony && !summary.ceremony.error && !summary.ceremony.cats?.includes("scoreo")) problems.push("ingen Orienterer-pall");
    }
    if (/hide/.test(String(args.plan)) && hostToken) {
      if (summary.game.hideLeaks > 0) problems.push(`${summary.game.hideLeaks} tick med radar/«Bytte i nærheten» til jeger eller pling til gjemmer i Gjemsel`);
      if (summary.bots >= 10 && summary.game.catches === 0) problems.push("ingen fangster i Gjemsel");
      if (summary.bots >= 10 && Object.keys(summary.game.hotcoldUsed ?? {}).length === 0) problems.push("ingen jeger brukte Snus/Termometer i Gjemsel");
      const long = String(args.plan).split(",").some((x) => /^hide/.test(x) && Number(x.split(":")[1]) >= 300);
      if (long && summary.bots >= 10 && summary.game.hidePlings === 0) problems.push("ingen stillstandspling i en lang Gjemsel-runde");
      if (args.ceremony && summary.ceremony && !summary.ceremony.error && !summary.ceremony.cats?.includes("hide")) problems.push("ingen Mestergjemmer-pall");
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
  }
  return { k, swarm, summary, problems, sessionId, kinds };
}

// ───────────────────────── helpers ─────────────────────────

// Teacher runs the ceremony (0006): start, reveal every podium, then the bots
// see their «ditt beste»-kort and vote. Result goes into summary.ceremony.
async function runCeremony(http, sessionId, hostToken) {
  const act = (action, payload) => http.post(`/api/s/${sessionId}/host`, { hostToken, action, payload });
  const st = await act("ceremony_start", { spread: true });
  if (st.status !== 200) return { error: `ceremony_start ${st.status} ${JSON.stringify(st.data)}` };
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
  return { podiums: total, step: snap.ceremony?.step, onPodium: onPodium.size, again: snap.ceremony?.again, cats, teamEntries };
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

function count(xs) {
  return xs.reduce((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

async function fetchRoomStats(liveStats, sessionId) {
  try {
    const res = await fetch(`${liveStats}/live/s/${sessionId}/stats`);
    if (!res.ok) return { error: `stats ${res.status}` };
    return await res.json();
  } catch (e) {
    return { error: `stats: ${e.message}` };
  }
}

// Compact per-session table (ws mode and --sessions).
function printTable(runs) {
  const row = (r) => {
    const s = r.summary;
    const w = s.ws;
    const rs = s.roomStats && !s.roomStats.error ? s.roomStats : null;
    return [
      `økt ${r.k + 1}`,
      s.transport,
      `bots ${s.bots}`,
      w ? `fix→view p50/p95/p99 ${w.fixView.p50}/${w.fixView.p95}/${w.fixView.p99} ms` : `tick p50/p95/p99 ${s.tickMs.p50}/${s.tickMs.p95}/${s.tickMs.p99} ms`,
      `alarm maks ${s.alarms.maxDelayS ?? "-"} s p95 ${s.alarms.p95S ?? "-"} s`,
      w ? `reconnects ${w.reconnects} (iPhone-drop ${w.iphoneDrops})` : "",
      w ? `posisjon→view p50/p95/p99 ${w.sampleView.p50}/${w.sampleView.p95}/${w.sampleView.p99} ms` : "",
      w ? `erstattet ${w.superseded} utsatt ${w.deferred} hint ${w.hints}` : "",
      s.alarms.outsideStages?.length
        ? `utenfor (gps/telefon/rom/lærer → sum s): ${s.alarms.outsideStages.map((o) => `${o.gpsS ?? "-"}/${o.phoneS ?? "-"}/${o.roomS ?? "-"}/${o.hostS ?? "-"}→${o.totalS}`).join(", ")}`
        : "",
      w?.kill ? `kill: tilbake på ${w.kill.recoveryS ?? "aldri"} s, mistet alarmer ${w.kill.missedAlarms}` : "",
      rs ? `rom: flush ${rs.flushes} batch maks ${rs.batchMax} snitt ${rs.flushes ? Math.round((rs.entries / rs.flushes) * 10) / 10 : 0} busy ${rs.busy} p50/p95 ${rs.flushP50}/${rs.flushP95} ms vert-push ${rs.hostPushes} vakthund ${rs.watchdogRuns} intervall p50/p95 ${rs.everyP50}/${rs.everyP95} ms venting p50/p95/maks ${rs.waitP50}/${rs.waitP95}/${rs.waitMax} ms holdt ${rs.held} haster ${rs.urgent ?? "-"}` : "",
    ].filter(Boolean).join(" | ");
  };
  console.log("\n" + runs.map(row).join("\n"));
}
