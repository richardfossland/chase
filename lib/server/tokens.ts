// Bearer tokens and their storage form (CLAUDE.md rule 7): the client keeps the
// raw token; the database only ever sees SHA-256 hex. Web Crypto, so the same
// code runs on Cloudflare Workers, Node and in vitest.

/** 32 random bytes, base64url (43 chars). */
export function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Shape check before hashing: rejects garbage early, never logs the value. */
export function isTokenShape(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9_-]{20,128}$/.test(v);
}
