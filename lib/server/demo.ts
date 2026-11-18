import "server-only";

/** Fase 10.6: demo-økter («Prøv med boter») og sim-merking i prod. */
export const DEMO_PER_HOUR = 3;
export const DEMO_MAX_ACTIVE = 10;

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

/** IPv6 normaliseres til /64 (første fire grupper); IPv4 og ukjent form beholdes. */
export function normalizeIp(ip: string): string {
  const v = ip.trim().toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) return mapped[1];
  if (!v.includes(":")) return v;
  const [head, tail] = v.split("::");
  const h = head ? head.split(":") : [];
  const t = tail === undefined ? [] : tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

/** Demo er avslått i prod uten DEMO_SALT. I dev/test brukes en fast testverdi. */
export function demoSalt(env: Record<string, string | undefined>): string | null {
  if (env.DEMO_SALT && env.DEMO_SALT.length >= 16) return env.DEMO_SALT;
  return env.NODE_ENV === "production" ? null : "dev-demo-salt-not-secret";
}

async function hmacHex(salt: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(salt), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** HMAC-SHA256-nøkler for demo_gate: IP (/64 for IPv6) og, hvis oppgitt, lærernøkkel. Saltet ligger bare på serveren. */
export async function demoKeys(salt: string, ip: string, teacherKey?: string): Promise<string[]> {
  const keys = [await hmacHex(salt, `ip:${normalizeIp(ip)}`)];
  if (teacherKey) keys.push(await hmacHex(salt, `teacher:${teacherKey}`));
  return keys;
}
