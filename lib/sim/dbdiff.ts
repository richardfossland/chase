// Snapshot diff math for scripts/dbstats.mjs (read-only DB counters).

export interface DbSnapshot {
  takenAt: string; // ISO
  database: Record<string, number>; // pg_stat_database row (numbers only)
  functions: Array<{ name: string; calls: number; total_time: number; self_time: number }>;
  statements: Array<{ query: string; calls: number; total_exec_time: number; rows: number }> | null;
}

export const DB_COUNTERS = ["xact_commit", "xact_rollback", "deadlocks", "blks_read", "blks_hit", "tup_returned", "tup_fetched", "tup_inserted", "tup_updated", "tup_deleted", "conflicts"] as const;

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

export function diffSnapshots(a: DbSnapshot, b: DbSnapshot) {
  const secs = (Date.parse(b.takenAt) - Date.parse(a.takenAt)) / 1000;
  if (!(secs > 0)) throw new Error("snapshot b må være tatt etter a");
  const delta: Record<string, number> = {};
  const perSec: Record<string, number> = {};
  for (const k of DB_COUNTERS) {
    if (a.database[k] === undefined || b.database[k] === undefined) continue;
    delta[k] = b.database[k] - a.database[k];
    perSec[k] = round(delta[k] / secs);
  }
  const xacts = (delta.xact_commit ?? 0) + (delta.xact_rollback ?? 0);
  const hit = delta.blks_hit ?? 0;
  const read = delta.blks_read ?? 0;
  const fa = new Map(a.functions.map((f) => [f.name, f]));
  const functions = b.functions
    .map((f) => {
      const o = fa.get(f.name);
      const calls = f.calls - (o?.calls ?? 0);
      const total = f.total_time - (o?.total_time ?? 0);
      const self = f.self_time - (o?.self_time ?? 0);
      return { name: f.name, calls, callsPerSec: round(calls / secs), totalMs: round(total), selfMs: round(self), avgMs: calls > 0 ? round(total / calls, 3) : 0 };
    })
    .filter((f) => f.calls > 0)
    .sort((x, y) => y.totalMs - x.totalMs);
  let statements: Array<{ query: string; calls: number; callsPerSec: number; totalMs: number; avgMs: number; rows: number }> | null = null;
  if (a.statements && b.statements) {
    const sa = new Map(a.statements.map((s) => [s.query, s]));
    statements = b.statements
      .map((s) => {
        const o = sa.get(s.query);
        const calls = s.calls - (o?.calls ?? 0);
        const total = s.total_exec_time - (o?.total_exec_time ?? 0);
        return { query: s.query, calls, callsPerSec: round(calls / secs), totalMs: round(total), avgMs: calls > 0 ? round(total / calls, 3) : 0, rows: s.rows - (o?.rows ?? 0) };
      })
      .filter((s) => s.calls > 0)
      .sort((x, y) => y.totalMs - x.totalMs);
  }
  return {
    seconds: round(secs, 1),
    transactions: xacts,
    tps: round(xacts / secs),
    rollbackPct: xacts > 0 ? round(((delta.xact_rollback ?? 0) / xacts) * 100) : 0,
    cacheHitPct: hit + read > 0 ? round((hit / (hit + read)) * 100) : null,
    delta,
    perSec,
    functions,
    statements,
  };
}
