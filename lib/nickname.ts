// Nickname checks (PLAN §2.2, §8). The server enforces length + uniqueness;
// this blocks obvious abuse and *warns* (does not block) when a nickname looks
// like a full name, so the pupil can pick something else.

const BLOCKED = [
  "faen", "fitte", "kuk", "hore", "jævla", "javla", "helvete", "neger", "pikk", "dritt",
  "fuck", "shit", "bitch", "cunt", "nigger", "nazi", "hitler",
];

export function normalizeNickname(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

export function isBlockedNickname(input: string): boolean {
  const flat = normalizeNickname(input).toLowerCase().replace(/[^a-zæøå0-9]/g, "");
  return BLOCKED.some((w) => flat.includes(w));
}

/** "Ola Nordmann" / "Kari Anne Hansen": two or more capitalised words. */
export function looksLikeFullName(input: string): boolean {
  return /^\p{Lu}\p{Ll}+(?:[ -]\p{Lu}\p{Ll}+)+$/u.test(normalizeNickname(input));
}
