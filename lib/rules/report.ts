// Ren aggregering for øktrapporten (fase 10.5). Ingen posisjoner, bare tall per
// kallenavn. Rapporten settes sammen i lærerens nettleser og lagres ikke.

export interface ReportPlayer {
  nickname: string;
  active_s: number;
  distance_m: number;
  posts: number;
  catches: number;
  quiz_right: number;
  badges: number;
  /** «Satt over»: vises i tabellen, men teller ikke i snitt og median. */
  sat_out?: boolean;
}

export interface ReportData {
  started_at: string;
  duration_s: number | null;
  rounds: { idx: number; mode: string; duration_s: number | null }[];
  players: ReportPlayer[];
}

export interface Stat {
  avg: number;
  median: number;
  total: number;
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function stat(xs: number[]): Stat {
  const total = xs.reduce((a, b) => a + b, 0);
  return { avg: xs.length ? total / xs.length : 0, median: median(xs), total };
}

/** Alfabetisk (norsk, uten hensyn til store/små bokstaver). Aldri rangert på poeng. */
export function sortAlphabetical(players: ReportPlayer[]): ReportPlayer[] {
  return [...players].sort((a, b) => a.nickname.localeCompare(b.nickname, "nb", { sensitivity: "base" }));
}

export function summarize(all: ReportPlayer[]) {
  const players = all.filter((p) => !p.sat_out);
  return {
    count: all.length,
    counted: players.length,
    activeMin: stat(players.map((p) => p.active_s / 60)),
    distance: stat(players.map((p) => p.distance_m)),
    posts: stat(players.map((p) => p.posts)),
    catches: stat(players.map((p) => p.catches)),
    quiz: stat(players.map((p) => p.quiz_right)),
  };
}
