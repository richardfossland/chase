// Physical QR post content (PLAN §3.1). A card's QR holds a URL so a phone's
// own camera app also works: https://chase.sundaysuite.app/q/<sessionId>/<CODE>.
// The in-app scanner accepts that URL or a typed code.

const CODE = /^[A-HJ-NP-Z2-9]{5}$/;

export function qrUrl(base: string, sessionId: string, code: string): string {
  return `${base.replace(/\/$/, "")}/q/${sessionId}/${code}`;
}

export function normCode(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Code from scanned text, or null if it is not a card for this session. */
export function parseQr(text: string, sessionId: string): string | null {
  const t = text.trim();
  const m = t.match(/\/q\/([0-9a-f-]{36})\/([A-Za-z0-9]{5})\/?$/i);
  if (m) return m[1].toLowerCase() === sessionId.toLowerCase() && CODE.test(normCode(m[2])) ? normCode(m[2]) : null;
  const c = normCode(t);
  return CODE.test(c) ? c : null;
}
