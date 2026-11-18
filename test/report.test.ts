import { describe, expect, it } from "vitest";

import { median, sortAlphabetical, stat, summarize, type ReportPlayer } from "@/lib/rules/report";

const p = (nickname: string, o: Partial<ReportPlayer> = {}): ReportPlayer => ({
  nickname, active_s: 0, distance_m: 0, posts: 0, catches: 0, quiz_right: 0, badges: 0, ...o,
});

describe("øktrapport", () => {
  it("median", () => {
    expect(median([])).toBe(0);
    expect(median([5])).toBe(5);
    expect(median([9, 1, 5])).toBe(5);
    expect(median([1, 2, 3, 10])).toBe(2.5);
  });
  it("stat gir snitt, median og sum", () => {
    expect(stat([2, 4, 12])).toEqual({ avg: 6, median: 4, total: 18 });
    expect(stat([])).toEqual({ avg: 0, median: 0, total: 0 });
  });
  it("sorterer alfabetisk, ikke på poeng, uten å endre inndata", () => {
    const input = [p("Zebra", { distance_m: 9000 }), p("ola"), p("Åse"), p("Anna")];
    const out = sortAlphabetical(input).map((x) => x.nickname);
    expect(out).toEqual(["Anna", "ola", "Zebra", "Åse"]);
    expect(input[0].nickname).toBe("Zebra");
  });
  it("summarize regner aktive minutter fra sekunder", () => {
    const s = summarize([p("a", { active_s: 600, posts: 2 }), p("b", { active_s: 1200, posts: 4 }), p("c", { active_s: 1800, posts: 0 })]);
    expect(s.count).toBe(3);
    expect(s.activeMin.median).toBe(20);
    expect(s.activeMin.avg).toBe(20);
    expect(s.posts.total).toBe(6);
  });
});
