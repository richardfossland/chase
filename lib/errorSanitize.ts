// Ren saniteringslogikk for klientfeil. Brukes både i nettleseren (før sending) og på serveren
// (forsvar i dybden). Personvern (CLAUDE.md regel 3): ingen posisjoner, tokens, ID-er, PIN-er eller
// URL-query skal noen gang ende i loggene.

export const MAX_MESSAGE = 300;
export const MAX_STACK = 1500;

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const URL_RE = /\b(?:https?|wss?):\/\/[^\s)'"<>]+/gi;
const COORD = /-?\d+\.\d{4,}/g;
const PIN = /(?<![\w.])\d{6}(?![\w.])/g;
// Lærernøkkel (A-Z0-9 med bindestrek), lange base64url-/hex-strenger (token, hash).
const KEY = /\b[A-Z0-9]{4,}(?:-[A-Z0-9]{3,}){2,}\b/g;
const LONG = /(?<![\w/.-])[A-Za-z0-9_-]{24,}(?![\w-])/g;

function stripUrl(raw: string, ownOrigin: string | null): string {
  try {
    const u = new URL(raw);
    if (ownOrigin && u.origin === ownOrigin) return u.pathname;
    return "[ekstern]";
  } catch {
    return "[url]";
  }
}

/** Fjerner persondata og identifikatorer fra en fritekststreng (melding eller stack). */
export function scrub(input: string, ownOrigin: string | null = null): string {
  return input
    .replace(URL_RE, (m) => stripUrl(m, ownOrigin))
    .replace(/(\/[\w.\[\]-]*)\?[^\s)'"<>]*/g, "$1")
    .replace(UUID, "[id]")
    .replace(COORD, "[tall]")
    .replace(KEY, "[nøkkel]")
    .replace(PIN, "[pin]")
    .replace(LONG, (m) => (/\d/.test(m) && /[A-Za-z]/.test(m) ? "[token]" : m));
}

export function sanitizeMessage(msg: unknown, ownOrigin: string | null = null): string {
  return scrub(String(msg ?? ""), ownOrigin).slice(0, MAX_MESSAGE);
}

export function sanitizeStack(stack: unknown, ownOrigin: string | null = null): string {
  if (typeof stack !== "string") return "";
  return scrub(stack, ownOrigin).slice(0, MAX_STACK);
}

/** Ruter vi kjenner, med dynamiske segmenter som mønster. Alt annet blir /[x]. */
export function routePattern(pathname: string): string {
  const path = (pathname.split(/[?#]/)[0] || "/").replace(/\/+$/, "") || "/";
  const seg = path.split("/").filter(Boolean);
  const [a, b, c] = seg;
  if (seg.length === 0) return "/";
  if (a === "play" && seg.length === 2) return "/play/[id]";
  if (a === "host") {
    if (seg.length === 2) return "/host/[id]";
    if (seg.length === 3 && (c === "poster" || c === "tavle")) return `/host/[id]/${c}`;
  }
  if (a === "j") return seg.length === 1 ? "/j" : "/j/[pin]";
  if (a === "d" && seg.length === 2) return "/d/[code]";
  if (a === "q") return seg.length === 2 ? "/q/[id]" : seg.length === 3 ? "/q/[id]/[code]" : "/[x]";
  if (a === "personvern") return seg.length === 1 ? "/personvern" : "/personvern/[slug]";
  if (a === "bibliotek") return b === "omrade" ? "/bibliotek/omrade/[id]/utskrift" : "/bibliotek";
  if (seg.length === 1 && (a === "ny" || a === "kart")) return `/${a}`;
  return "/[x]";
}

/** Grov familie: ingen full user-agent. */
export function uaFamily(ua: string): string {
  const os = /iPhone|iPad|iPod/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Windows|Macintosh|Linux|CrOS/.test(ua)
        ? "desktop"
        : "annet";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox|FxiOS/.test(ua)
      ? "Firefox"
      : /SamsungBrowser/.test(ua)
        ? "Samsung"
        : /Chrome|CriOS/.test(ua)
          ? "Chrome"
          : /Safari/.test(ua)
            ? "Safari"
            : "annet";
  return `${os}/${browser}`;
}

const NOISE = [
  /ResizeObserver loop/i,
  /chrome-extension:\/\//i,
  /moz-extension:\/\//i,
  /safari-extension:\/\//i,
  /^Script error\.?$/i,
];

/** Støy vi ikke vil rapportere (nettleserutvidelser, kryss-origin-skript uten info). */
export function isNoise(message: string, stack: string | undefined, ownOrigin: string | null): boolean {
  if (NOISE.some((r) => r.test(message) || (stack ? r.test(stack) : false))) return true;
  if (stack && ownOrigin) {
    const urls = stack.match(URL_RE) ?? [];
    if (urls.length > 0 && urls.every((u) => !u.startsWith(ownOrigin))) return true;
  }
  return false;
}
