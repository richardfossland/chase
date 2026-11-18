// Sikkerhetsheadere (fase 10.2). Rene funksjoner, brukt av next.config.ts og testet i test/security-headers.test.ts.
//
// script-src har 'unsafe-inline' fordi Next App Router sender inline-skript
// (self.__next_f.push for RSC-payload og bootstrap). Nonce krever dynamisk rendering via
// proxy/middleware på alle ruter og gir ingen reell gevinst her, siden appen ikke
// rendrer brukerstyrt HTML (ingen dangerouslySetInnerHTML). 'unsafe-eval' kun i dev (HMR).
// style-src har 'unsafe-inline' fordi React/MapLibre setter style-attributter.

export interface CspOptions {
  /** NEXT_PUBLIC_SUPABASE_URL (prod: https://<ref>.supabase.co, lokalt: http://127.0.0.1:55321). */
  supabaseUrl?: string;
  /** NEXT_PUBLIC_LIVE_WS_BASE, bare for lokal chase-live (ws://127.0.0.1:8787). */
  liveWsBase?: string;
  dev?: boolean;
}

const KARTVERKET = "https://cache.kartverket.no";

export const PERMISSIONS_POLICY =
  "geolocation=(self), camera=(self), microphone=(), payment=(), usb=(), screen-wake-lock=(self)";

function parse(raw: string | undefined): URL | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return ["http:", "https:", "ws:", "wss:"].includes(u.protocol) ? u : null;
  } catch {
    return null;
  }
}

/** https://x → [https://x, wss://x]; http://x → [http://x, ws://x]; ws(s) beholdes. */
function httpAndWs(u: URL): string[] {
  if (u.protocol === "ws:" || u.protocol === "wss:") return [`${u.protocol}//${u.host}`];
  const secure = u.protocol === "https:";
  return [u.origin, `${secure ? "wss" : "ws"}://${u.host}`];
}

export function buildCsp(o: CspOptions = {}): string {
  const connect = new Set<string>(["'self'", KARTVERKET]);
  const sb = parse(o.supabaseUrl);
  if (sb) for (const s of httpAndWs(sb)) connect.add(s);
  const live = parse(o.liveWsBase);
  if (live) for (const s of httpAndWs(live)) connect.add(s);
  const scripts = ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'"];
  if (o.dev) scripts.push("'unsafe-eval'");
  const d: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": scripts,
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:", KARTVERKET],
    "font-src": ["'self'", "data:"],
    "connect-src": [...connect],
    "worker-src": ["'self'", "blob:"],
    "media-src": ["'self'", "blob:"],
    "manifest-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  };
  const parts = Object.entries(d).map(([k, v]) => `${k} ${v.join(" ")}`);
  if (!o.dev) parts.push("upgrade-insecure-requests");
  return parts.join("; ");
}

/** Alle headere som sendes på sider og API-svar fra Next. */
export function securityHeaders(o: CspOptions = {}): { key: string; value: string }[] {
  const h = [
    { key: "Content-Security-Policy", value: buildCsp(o) },
    { key: "Permissions-Policy", value: PERMISSIONS_POLICY },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
  ];
  // HSTS bare i prod: aldri send det fra http://localhost.
  if (!o.dev) h.push({ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" });
  return h;
}
