import { isNoise, routePattern, sanitizeMessage, sanitizeStack, uaFamily } from "@/lib/errorSanitize";

// Lettvekts feilrapportering. Sender kun sanert melding/stack, rutemønster, build-id, UA-familie
// og tid til /api/log. Ingen avhengigheter, ingen await i varme stier (regel 4).

const MAX_REPORTS = 5;
let installed = false;
let sent = 0;
const seen = new Set<string>();

export function reportError(err: unknown, extra?: { message?: string }): void {
  try {
    if (typeof window === "undefined" || sent >= MAX_REPORTS) return;
    const own = window.location.origin;
    const e = err as { message?: unknown; stack?: unknown } | null;
    const rawMsg = extra?.message ?? (typeof err === "string" ? err : String(e?.message ?? "ukjent"));
    const rawStack = typeof e?.stack === "string" ? e.stack : undefined;
    if (isNoise(rawMsg, rawStack, own)) return;
    const message = sanitizeMessage(rawMsg, own);
    const stack = sanitizeStack(rawStack, own);
    const route = routePattern(window.location.pathname);
    const key = `${route}|${message}|${stack.slice(0, 200)}`;
    if (seen.has(key)) return;
    seen.add(key);
    sent++;
    const body = JSON.stringify({
      message,
      stack,
      route,
      build: process.env.NEXT_PUBLIC_BUILD_ID || undefined,
      ua: uaFamily(navigator.userAgent),
      at: new Date().toISOString(),
    });
    const blob = new Blob([body], { type: "application/json" });
    if (typeof navigator.sendBeacon === "function" && navigator.sendBeacon("/api/log", blob)) return;
    void fetch("/api/log", {
      method: "POST",
      body,
      headers: { "content-type": "application/json" },
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Feilrapportering skal aldri selv feile synlig.
  }
}

/** Installerer globale fangere én gang per sideinnlasting. */
export function installErrorReporting(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (ev) => {
    if (ev.error) reportError(ev.error);
    else reportError(null, { message: ev.message });
  });
  window.addEventListener("unhandledrejection", (ev) => reportError(ev.reason ?? "unhandledrejection"));
}

/** Test-only. */
export function __resetErrorReport(): void {
  installed = false;
  sent = 0;
  seen.clear();
}
