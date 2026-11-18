import "server-only";

import { sha256Hex } from "@/lib/server/tokens";

/** Fase 10.6: demo-økter («Prøv med boter») og sim-merking i prod. */
export const DEMO_PER_HOUR = 3;
export const DEMO_MAX_ACTIVE = 40;

/** Sammenligning av hemmelig SIM_KEY i konstant tid. Tom eller for kort nøkkel i miljøet gir aldri treff. */
export function simKeyOk(env: Record<string, string | undefined>,header: string | null): boolean {
  const want = env.SIM_KEY;
  if (!want || want.length < 16 || !header || header.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ header.charCodeAt(i);
  return diff === 0;
}

export interface SessionFlags {
  isSim: boolean;
  demo: boolean;
}

/**
 * `sim: true` gjelder bare med SIM_ENABLED=1 (dev) eller riktig `x-sim-key` (prod-sim fra scripts/sim.mjs).
 * `demo: true` er alltid lov (med vern i demo_gate) og gir is_sim + settings.demo.
 */
export function sessionFlags(
  body: { sim?: boolean; demo?: boolean },
  env: Record<string, string | undefined>,
  simKeyHeader: string | null,
): SessionFlags {
  const demo = body.demo === true;
  const sim = body.sim === true && (env.SIM_ENABLED === "1" || simKeyOk(env, simKeyHeader));
  return { isSim: sim || demo, demo };
}

/** Hashede nøkler for demo_gate: IP og (hvis oppgitt) lærernøkkel. */
export async function demoKeys(ip: string, teacherKey?: string): Promise<string[]> {
  const keys = [await sha256Hex(`demo-ip:${ip}`)];
  if (teacherKey) keys.push(await sha256Hex(`demo-teacher:${teacherKey}`));
  return keys;
}
