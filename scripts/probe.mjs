// Synthetic uptime probe (T1). Hits real hostnames from an external vantage
// point (GitHub Actions runner) — NOT a Cloudflare Worker — so it also
// catches edge-level failures a Worker cron would be blind to (e.g. an
// intermittent dropped-request symptom that a Worker-side cron can't see).
//
// Node 22, zero dependencies (built-in fetch/AbortSignal.timeout only).
//
// Usage:
//   node scripts/probe.mjs [path/to/targets.json]
// Defaults to .github/uptime-targets.json relative to the repo root (cwd).
//
// Exit code is 1 if any target breaches its maxFailRate or p95Ms budget,
// so this doubles as a CI/cron gate. Writes probe.json with every raw
// sample (status, elapsed ms, cf-ray, cf-cache-status) so a Cloudflare
// support ticket has evidence to point at.

import { writeFile, appendFile, readFile } from "node:fs/promises";

const targetsPath = process.argv[2] || ".github/uptime-targets.json";

function normalizePathDef(def) {
  if (typeof def === "string") {
    return { path: def, method: "GET", expect: [200], note: undefined };
  }
  return {
    path: def.path,
    method: def.method || "GET",
    expect: Array.isArray(def.expect) && def.expect.length > 0 ? def.expect : [200],
    note: def.note,
  };
}

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  const idx = Math.ceil((p / 100) * sortedAsc.length) - 1;
  return sortedAsc[Math.max(0, Math.min(sortedAsc.length - 1, idx))];
}

async function probeOnce(base, pathDef, timeoutMs) {
  const url = new URL(pathDef.path, base).toString();
  const startedAt = new Date().toISOString();
  const start = performance.now();
  try {
    const res = await fetch(url, {
      method: pathDef.method,
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "sunday-uptime/1" },
    });
    const elapsedMs = Math.round(performance.now() - start);
    const ok = pathDef.expect.includes(res.status);
    return {
      startedAt,
      url,
      method: pathDef.method,
      ok,
      status: res.status,
      elapsedMs,
      cfRay: res.headers.get("cf-ray"),
      cfCacheStatus: res.headers.get("cf-cache-status"),
      error: null,
    };
  } catch (err) {
    // A timeout or network error is exactly today's symptom (edge silently
    // drops the request) — always a failure, never "inconclusive".
    const elapsedMs = Math.round(performance.now() - start);
    const isTimeout = err && (err.name === "TimeoutError" || err.name === "AbortError");
    return {
      startedAt,
      url,
      method: pathDef.method,
      ok: false,
      status: null,
      elapsedMs,
      cfRay: null,
      cfCacheStatus: null,
      error: isTimeout ? "timeout" : String((err && err.message) || err),
    };
  }
}

async function probeTarget(target) {
  const pathDefs = target.paths.map(normalizePathDef);
  const pathResults = [];

  for (const pathDef of pathDefs) {
    const samples = [];
    for (let i = 0; i < target.samples; i++) {
      // Sequential by design: this measures the same kind of single request
      // a real visitor makes, not burst load.
      samples.push(await probeOnce(target.base, pathDef, target.timeoutMs));
    }
    const fails = samples.filter((s) => !s.ok).length;
    const failRate = fails / samples.length;
    const elapsedSorted = samples.map((s) => s.elapsedMs).sort((a, b) => a - b);
    pathResults.push({
      path: pathDef.path,
      method: pathDef.method,
      note: pathDef.note,
      samples,
      fails,
      failRate,
      p95Ms: percentile(elapsedSorted, 95),
    });
  }

  const allSamples = pathResults.flatMap((p) => p.samples);
  const totalFails = allSamples.filter((s) => !s.ok).length;
  const targetFailRate = totalFails / allSamples.length;
  const targetElapsedSorted = allSamples.map((s) => s.elapsedMs).sort((a, b) => a - b);
  const targetP95Ms = percentile(targetElapsedSorted, 95);
  const breachedFailRate = targetFailRate > target.maxFailRate;
  const breachedP95 = target.p95Ms != null && targetP95Ms != null && targetP95Ms > target.p95Ms;

  return {
    name: target.name,
    base: target.base,
    maxFailRate: target.maxFailRate,
    p95MsBudget: target.p95Ms,
    failRate: targetFailRate,
    p95Ms: targetP95Ms,
    breached: breachedFailRate || breachedP95,
    breachedFailRate,
    breachedP95,
    paths: pathResults,
  };
}

function fmtPct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

function renderMarkdown(results) {
  const lines = [];
  lines.push("## Uptime probe results");
  lines.push("");
  lines.push(`Run: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("| Target | Path | Method | Samples | Fails | Fail rate | p95 (ms) | Last status | Last cf-ray | Last cache | Status |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const target of results) {
    for (const p of target.paths) {
      const last = p.samples[p.samples.length - 1];
      const rowBreach = p.failRate > target.maxFailRate || (target.p95MsBudget != null && p.p95Ms != null && p.p95Ms > target.p95MsBudget);
      lines.push(
        `| ${target.name} | \`${p.path}\` | ${p.method} | ${p.samples.length} | ${p.fails} | ${fmtPct(p.failRate)} | ${p.p95Ms ?? "—"} | ${last.status ?? `error: ${last.error}`} | ${last.cfRay ?? "—"} | ${last.cfCacheStatus ?? "—"} | ${rowBreach ? "🔴" : "🟢"} |`
      );
    }
    lines.push(
      `| **${target.name} (overall)** |  |  | ${target.paths.reduce((n, p) => n + p.samples.length, 0)} |  | **${fmtPct(target.failRate)}** (budget ${fmtPct(target.maxFailRate)}) | **${target.p95Ms ?? "—"}** (budget ${target.p95MsBudget ?? "—"}) |  |  |  | ${target.breached ? "🔴 BREACH" : "🟢 OK"} |`
    );
  }
  const notes = results.flatMap((t) => t.paths.filter((p) => p.note).map((p) => `- \`${t.name}\` \`${p.path}\`: ${p.note}`));
  if (notes.length > 0) {
    lines.push("");
    lines.push("Notes:");
    lines.push(...notes);
  }
  return lines.join("\n") + "\n";
}

async function main() {
  const raw = await readFile(targetsPath, "utf8");
  const config = JSON.parse(raw);
  const results = [];
  for (const target of config.targets) {
    results.push(await probeTarget(target));
  }

  const markdown = renderMarkdown(results);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    await appendFile(summaryPath, markdown);
  }
  console.log(markdown);

  await writeFile(
    "probe.json",
    JSON.stringify({ ranAt: new Date().toISOString(), targets: results }, null, 2)
  );

  const anyBreach = results.some((t) => t.breached);
  if (anyBreach) {
    console.error("Uptime probe FAILED: one or more targets breached maxFailRate or p95Ms.");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("probe.mjs crashed:", err);
  process.exitCode = 1;
});
