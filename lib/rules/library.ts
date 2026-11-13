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
