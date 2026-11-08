// Code generation for join PINs and human-friendly resume codes.
// Pure + injectable RNG so it is deterministic under test.

// Ambiguous characters removed: I, O, 0, 1 (and L vs 1 risk → keep L, drop 1).
const LETTERS = "ABCDEFGHJKMNPQRSTUVWXYZ"; // no I, O
const ALNUM = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no I, O, 0, 1

export type Rng = () => number; // returns [0,1)

function pick(alphabet: string, rng: Rng): string {
  return alphabet[Math.floor(rng() * alphabet.length)];
}

/** 6-digit room PIN, e.g. "402815". Leading digits allowed. */
export function generatePin(rng: Rng = Math.random): string {
  let pin = "";
  for (let i = 0; i < 6; i++) pin += Math.floor(rng() * 10).toString();
  return pin;
}

/** Resume code: 4 letters + dash + 2 alphanumerics, e.g. "KOLE-7F".
 * No ambiguous characters. */
export function generateResumeCode(rng: Rng = Math.random): string {
  let head = "";
  for (let i = 0; i < 4; i++) head += pick(LETTERS, rng);
  let tail = "";
  for (let i = 0; i < 2; i++) tail += pick(ALNUM, rng);
  return `${head}-${tail}`;
}

/** Host resume code — same shape, distinct prefix space not required. */
export function generateHostCode(rng: Rng = Math.random): string {
  return generateResumeCode(rng);
}

/** Normalise a user-typed code: uppercase, strip spaces, ensure single dash. */
export function normalizeResumeCode(input: string): string {
  const cleaned = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (cleaned.length !== 6) return input.trim().toUpperCase();
  return `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`;
}

const PIN_RE = /^\d{6}$/;
export function isValidPin(input: string): boolean {
  return PIN_RE.test(input.trim());
}

/** Generate a code guaranteed unique against an existing set (retry on clash). */
export function generateUnique(
  gen: (rng: Rng) => string,
  taken: ReadonlySet<string>,
  rng: Rng = Math.random,
  maxTries = 50,
): string {
  for (let i = 0; i < maxTries; i++) {
    const code = gen(rng);
    if (!taken.has(code)) return code;
  }
  throw new Error("Could not generate a unique code");
}
