"use client";

// Local bearer identities (pattern from Sjakk's identity.ts). Only secrets that
// let this device act — never game state, which is always refetched.
//   * lærernøkkel: the teacher's long-lived recovery key (PLAN §0.14, phase 6 export)
//   * host token per session
//   * the single active player identity on this device
//   * a random device id (lets the teacher's «fjern» stick)

const TEACHER_KEY = "chase:teacher-key";
const HOST_KEY = (id: string) => `chase:host:${id}`;
const PLAYER_KEY = "chase:player";
const DEVICE_KEY = "chase:device";
const SEEN_INTRO = "chase:seen-intro";

const KEY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no I, O, 0, 1, L

export interface StoredPlayer {
  sessionId: string;
  playerId: string;
  token: string;
  resumeCode: string;
  nickname: string;
  pin: string;
}

function get(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function set(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    console.warn("[identity] localStorage write failed", e);
  }
}

function randomFrom(alphabet: string, n: number): string {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  // 256 % 31 bias is negligible for a recovery key; keep it simple.
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

/** "ABCD-EFGH-JKMN-PQRS" — ~79 bits. */
export function generateTeacherKey(): string {
  return randomFrom(KEY_ALPHABET, 16).match(/.{4}/g)!.join("-");
}

export const identity = {
  teacherKey(): string | null {
    return get(TEACHER_KEY);
  },
  ensureTeacherKey(): { key: string; created: boolean } {
    const existing = get(TEACHER_KEY);
    if (existing) return { key: existing, created: false };
    const key = generateTeacherKey();
    set(TEACHER_KEY, key);
    return { key, created: true };
  },
  /** Import on another device (0010): this key's library becomes mine here. */
  setTeacherKey(key: string) {
    set(TEACHER_KEY, key);
    set(SEEN_INTRO, "1");
  },
  hasSeenIntro: () => get(SEEN_INTRO) === "1",
  markIntroSeen: () => set(SEEN_INTRO, "1"),

  saveHostToken: (sessionId: string, token: string) => set(HOST_KEY(sessionId), token),
  hostToken: (sessionId: string) => get(HOST_KEY(sessionId)),

  savePlayer: (p: StoredPlayer) => set(PLAYER_KEY, JSON.stringify(p)),
  player(): StoredPlayer | null {
    const raw = get(PLAYER_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StoredPlayer;
    } catch {
      return null;
    }
  },
  clearPlayer() {
    try {
      localStorage.removeItem(PLAYER_KEY);
    } catch {
      /* ignore */
    }
  },
  deviceId(): string {
    let id = get(DEVICE_KEY);
    if (!id) {
      id = randomFrom("abcdefghijkmnpqrstuvwxyz23456789", 20);
      set(DEVICE_KEY, id);
    }
    return id;
  },
};
