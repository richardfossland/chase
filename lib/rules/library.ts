// TS twin of chase.kb() and the pure library rules in
// supabase/migrations/0010_library_sharing.sql (CLAUDE.md rule 2). The server
// decides; the client uses these to validate as the teacher types.
// test/library.test.ts diffs LIBRARY against the SQL and runs the same vectors
// as test/sql/0010_library_sharing.test.sql.

export const LIBRARY = {
  recent_keep: 5,
  saved_max: 50,
  shares_max: 30,
  missions_max: 12,
  mission_min: 2,
  mission_max: 80,
  name_max: 80,
  code_len: 8,
  teacher_idle_d: 395,
} as const;

const squash = (s: string) => s.trim().replace(/\s+/g, " ");

/** Same as chase._norm_missions(): 1..12 strings, trimmed, 2..80 chars, case-insensitive dedupe. null = invalid. */
export function normMissions(p: unknown): string[] | null {
  if (!Array.isArray(p) || p.length < 1 || p.length > LIBRARY.missions_max) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of p) {
    if (typeof x !== "string") return null;
    const t = squash(x);
    if ([...t].length < LIBRARY.mission_min || [...t].length > LIBRARY.mission_max) return null;
    if (!seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      out.push(t);
    }
  }
  return out;
}

/** Same as chase._norm_name(). */
export function normName(p: string | null | undefined): string | null {
  const t = squash(p ?? "");
  return t.length >= 1 && [...t].length <= LIBRARY.name_max ? t : null;
}

const CODE = /^[A-HJ-NP-Z2-9]{8}$/;
/** A share code from a typed code or a pasted /d/<code> link, else null. */
export function parseShareCode(s: string): string | null {
  const m = s.trim().match(/\/d\/([A-Za-z0-9]{8})\/?(?:[?#].*)?$/);
  const c = (m ? m[1] : s).toUpperCase().replace(/[^A-Z0-9]/g, "");
  return CODE.test(c) ? c : null;
}

const KEY = /^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/;
/** «Lærernøkkel» from typed text (any case/spacing) or a scanned CHASE-KEY QR, else null. */
export function parseTeacherKey(s: string): string | null {
  const raw = s.trim().replace(/^CHASE-KEY:/i, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (raw.length !== 16) return null;
  const k = raw.match(/.{4}/g)!.join("-");
  return KEY.test(k) ? k : null;
}

/** QR content for exporting the key to another device (scanned in-app, never a URL). */
export function teacherKeyQr(key: string): string {
  return `CHASE-KEY:${key}`;
}

// ───────── 0016: faste poster per sted (twin of chase._norm_posts) ─────────

export const POSTS_MAX = 40; // = GAME.posts_max (chase.kg('posts_max'))
export const POST_NAME_MAX = 40;
export const POST_CODE = /^[A-HJ-NP-Z2-9]{5}$/;
const POST_ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export interface FixedPost {
  lat: number;
  lng: number;
  name?: string;
  kind: "normal" | "golden";
  qr: boolean;
  /** Stable 5-char QR code; required when qr = true. */
  code?: string;
}

const round6 = (x: number) => Math.sign(x) * (Math.round(Math.abs(x) * 1e6) / 1e6);

/** Same as chase._norm_posts(): 0..40 posts, lat/lng to 6 decimals, name 1..40 chars, qr posts need a unique code. null = invalid. */
export function normPosts(p: unknown): FixedPost[] | null {
  if (p === null || p === undefined) return [];
  if (!Array.isArray(p) || p.length > POSTS_MAX) return null;
  const out: FixedPost[] = [];
  const codes = new Set<string>();
  for (const x of p) {
    if (typeof x !== "object" || x === null || Array.isArray(x)) return null;
    const o = x as Record<string, unknown>;
    if (typeof o.lat !== "number" || typeof o.lng !== "number" || !Number.isFinite(o.lat) || !Number.isFinite(o.lng)) return null;
    if (o.lat < -90 || o.lat > 90 || o.lng < -180 || o.lng > 180) return null;
    const kind = o.kind ?? "normal";
    if (kind !== "normal" && kind !== "golden") return null;
    if (o.qr !== undefined && o.qr !== null && typeof o.qr !== "boolean") return null;
    const qr = o.qr === true;
    const post: FixedPost = { lat: round6(o.lat), lng: round6(o.lng), kind, qr };
    if (typeof o.name === "string") {
      const n = squash(o.name);
      if ([...n].length > POST_NAME_MAX) return null;
      if (n) post.name = n;
    } else if (o.name !== undefined && o.name !== null) return null;
    if (qr) {
      const c = String(o.code ?? "").toUpperCase();
      if (!POST_CODE.test(c) || codes.has(c)) return null;
      codes.add(c);
      post.code = c;
    }
    out.push(post);
  }
  return out;
}

/** A fresh QR code for a post, unique among `taken`. */
export function newPostCode(taken: Iterable<string>, rand: () => number = Math.random): string {
  const used = new Set(taken);
  for (;;) {
    let c = "";
    for (let i = 0; i < 5; i++) c += POST_ALPHA[Math.floor(rand() * POST_ALPHA.length)];
    if (!used.has(c)) return c;
  }
}
