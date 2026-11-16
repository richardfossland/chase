// Pure helpers for scripts/sim.mjs (flag parsing, ws-mode gate thresholds,
// aggregation across sessions). Kept here so they are unit tested.

import { percentile, type SimStats } from "./driver";

export function parseArgs(argv: string[]): Record<string, string | true> {
  const o: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq > 0) {
      o[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
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

export interface SimConfig {
  transport: "ws" | "http";
  sessions: number;
  killAtS: number | null;
  liveWs: string | null;
  liveStats: string | null;
}

export function parseSimConfig(args: Record<string, string | true>): SimConfig {
  const transport = args.transport === undefined ? "http" : String(args.transport);
  if (transport !== "ws" && transport !== "http") throw new Error(`--transport må være ws eller http (fikk ${transport})`);
  const sessions = args.sessions === undefined ? 1 : Number(args.sessions);
  if (!Number.isInteger(sessions) || sessions < 1 || sessions > 50) throw new Error("--sessions må være et heltall 1–50");
  let killAtS: number | null = null;
  if (args["kill-at"] !== undefined) {
    killAtS = Number(args["kill-at"]);
    if (!Number.isFinite(killAtS) || killAtS <= 0) throw new Error("--kill-at må være et positivt antall sekunder");
    if (transport !== "ws") throw new Error("--kill-at krever --transport ws");
  }
  const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string).replace(/\/$/, "") : null);
  return { transport, sessions, killAtS, liveWs: str("live-ws"), liveStats: str("live-stats") };
}

/** What the ws-mode gate looks at, per run (aggregated over sessions). */
export interface WsGateInput {
  errors5xx: number;
  alarmMaxS: number | null;
  alarmP95S: number | null;
  fixViewP95: number;
  fixViewP99: number;
  fixViewN: number;
  killAtS: number | null;
  /** seconds until >= 95 % were back; null = never (worst session) */
  recoveryS: number | null;
  missedAlarmsAfterKill: number;
}

// fix→view p95 2 s (eier 11-16): 1,9 s-fartsregel + skriving 1/s gir ~1,6 s.
export const WS_GATE = { alarmMaxS: 5, alarmP95S: 3, fixViewP95Ms: 2000, fixViewP99Ms: 3000, recoveryS: 10 } as const;

export function wsGateProblems(g: WsGateInput): string[] {
  const p: string[] = [];
  if (g.errors5xx > 0) p.push(`${g.errors5xx} 5xx-svar`);
  if (g.alarmMaxS !== null && g.alarmMaxS >= WS_GATE.alarmMaxS) p.push(`alarm maks ${g.alarmMaxS} s (≥ ${WS_GATE.alarmMaxS} s)`);
  if (g.alarmP95S !== null && g.alarmP95S >= WS_GATE.alarmP95S) p.push(`alarm p95 ${g.alarmP95S} s (≥ ${WS_GATE.alarmP95S} s)`);
  if (g.fixViewN === 0) p.push("ingen fix→view målt (ingen bot var på ws?)");
  if (g.fixViewP95 >= WS_GATE.fixViewP95Ms) p.push(`fix→view p95 ${g.fixViewP95} ms (≥ ${WS_GATE.fixViewP95Ms} ms)`);
  if (g.fixViewP99 >= WS_GATE.fixViewP99Ms) p.push(`fix→view p99 ${g.fixViewP99} ms (≥ ${WS_GATE.fixViewP99Ms} ms)`);
  if (g.killAtS !== null) {
    if (g.recoveryS === null) p.push("--kill-at: under 95 % kom tilbake på ws");
    else if (g.recoveryS > WS_GATE.recoveryS) p.push(`--kill-at: ${g.recoveryS} s til ≥ 95 % var tilbake (> ${WS_GATE.recoveryS} s)`);
    if (g.missedAlarmsAfterKill > 0) p.push(`--kill-at: ${g.missedAlarmsAfterKill} alarm(er) ble aldri sett`);
  }
  return p;
}

export function count5xx(errors: Record<string, number>): number {
  return Object.entries(errors).reduce((n, [k, v]) => (/_5\d\d(_|$)/.test(k) ? n + v : n), 0);
}

/** Merge stats of several sessions into one gate input (percentiles over all samples). */
export function aggregateGate(all: SimStats[], killAtS: number | null): WsGateInput {
  const fix = all.flatMap((s) => s.ws?.fixView ?? []);
  const alarm = all.flatMap((s) => s.alarms.filter((a) => a.seenAt !== null).map((a) => (a.seenAt! - a.expectedAt) / 1000));
  const errs: Record<string, number> = {};
  for (const s of all) for (const [k, v] of Object.entries(s.errors)) errs[k] = (errs[k] ?? 0) + v;
  let recoveryS: number | null = killAtS === null ? null : 0;
  let missed = 0;
  for (const s of all) {
    const k = s.ws?.kill;
    if (!k) continue;
    if (k.recoveredAt === null) recoveryS = null;
    else if (recoveryS !== null) recoveryS = Math.max(recoveryS, (k.recoveredAt - k.at) / 1000);
    missed += s.alarms.filter((a) => a.expectedAt >= k.at && a.seenAt === null && Date.now() - a.expectedAt > 5000).length;
  }
  return {
    errors5xx: count5xx(errs),
    alarmMaxS: alarm.length ? Math.max(...alarm) : null,
    alarmP95S: alarm.length ? percentile(alarm, 95) : null,
    fixViewP95: percentile(fix, 95),
    fixViewP99: percentile(fix, 99),
    fixViewN: fix.length,
    killAtS,
    recoveryS: recoveryS === null ? null : Math.round(recoveryS * 10) / 10,
    missedAlarmsAfterKill: missed,
  };
}
