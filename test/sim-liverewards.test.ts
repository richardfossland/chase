import { describe, expect, it } from "vitest";

import { createBot, defaultMix, lockerSilent, parseMix, type BotView, type SimGeo } from "@/lib/sim/behaviours";
import {
  expectedMult,
  judgeWindow,
  liveRewardsProblems,
  newLiveStats,
  newWindow,
  observeView,
  pointsProblem,
  recordHunterView,
  revealMatches,
  revealProblem,
  streakProblem,
  type LiveView,
} from "@/lib/sim/liverewards";

const ring = [[10.75, 59.91], [10.7518, 59.91], [10.7518, 59.9109], [10.75, 59.9109], [10.75, 59.91]];
const geo: SimGeo = { boundary: { coordinates: [ring] }, forbidden: null, assembly: { lat: 59.91045, lng: 10.7509 } };

describe("locker behaviour", () => {
  it("lockerSilent is a half-open window", () => {
    expect(lockerSilent(10, null, 40)).toBe(false);
    expect(lockerSilent(9, 10, 40)).toBe(false);
    expect(lockerSilent(10, 10, 40)).toBe(true);
    expect(lockerSilent(49, 10, 40)).toBe(true);
    expect(lockerSilent(50, 10, 40)).toBe(false);
  });

  function run(kind: "locker" | "locker70", seed: number) {
    const bot = createBot(kind, geo, { seed, lockAfterLiveS: 20 });
    bot.observe({ status: "live" } as BotView);
    const out = [];
    for (let t = 0; t < 200; t += 2) out.push(bot.step(2));
    return out;
  }

  it("goes completely silent for 40 s (70 s) after 20 live seconds, then returns", () => {
    for (const [kind, n] of [["locker", 20], ["locker70", 35]] as const) {
      const s = run(kind, 3);
      const idx = s.map((x, i) => (x.silent ? i : -1)).filter((i) => i >= 0);
      expect(idx).toHaveLength(n);
      expect(idx[idx.length - 1] - idx[0]).toBe(n - 1); // contiguous
      expect(idx[0]).toBe(9); // 20 live s / 2 s per step
      expect(s.filter((x) => x.silent).every((x) => x.fix === null && x.silent!.forS === n * 2)).toBe(true);
      expect(s.filter((x) => !x.silent).every((x) => x.fix !== null)).toBe(true);
    }
  });

  it("does not start the clock before the round is live, and is deterministic", () => {
    const bot = createBot("locker", geo, { seed: 1, lockAfterLiveS: 10 });
    for (let i = 0; i < 50; i++) expect(bot.step(2).silent).toBeUndefined(); // no view = not live
    expect(run("locker", 5)).toEqual(run("locker", 5));
  });

  it("mix: lockers only with live rewards", () => {
    expect(defaultMix(40)).not.toContain("locker");
    const m = defaultMix(40, true);
    expect(m).toContain("locker");
    expect(m).toContain("locker70");
    expect(m).toHaveLength(40);
    expect(parseMix("locker:2,locker70:1")).toEqual(["locker", "locker", "locker70"]);
  });
});

const pos = { lat: 59.9101, lng: 10.7505 };
const before: LiveView = { status: "live", role: "prey", round_idx: 0, tag: { variant: "convert" }, stats: { points: 10, round_points: 10 }, live: { on: true, mult: 1.25, streak_s: 130 } };
const mk = (b: LiveView = before) => newWindow({ playerId: "p1", kind: "locker", lastSentAt: 1000, lastPos: pos, now: 3000, before: b });

describe("points", () => {
  it("accepts normal movement, flags a paid silent window", () => {
    const w = mk();
    w.returnedAt = 1000 + 42_000;
    const ok: LiveView = { status: "live", round_idx: 0, stats: { points: 12, round_points: 12 } };
    expect(pointsProblem(w, ok, 4)).toBeNull();
    const paid: LiveView = { status: "live", round_idx: 0, stats: { points: 20, round_points: 20 } };
    expect(pointsProblem(w, paid, 4)).toMatch(/\+10/);
  });
  it("Gjemsel gives no minute points; claims and new rounds are skipped", () => {
    const w = mk({ ...before, tag: { variant: "hide" } });
    w.returnedAt = 41_000;
    expect(pointsProblem(w, { status: "live", round_idx: 0, stats: { points: 15, round_points: 15 } }, 4)).not.toBeNull();
    expect(pointsProblem(w, { status: "live", round_idx: 0, stats: { points: 15 }, claimed: {} }, 4)).toBeNull();
    expect(pointsProblem(w, { status: "live", round_idx: 1, stats: { points: 99 } }, 4)).toBeNull();
  });
});

describe("reveal", () => {
  const hunter = (revealed: { id: string; pos: typeof pos }[]): LiveView => ({ status: "live", role: "hunter", tag: { variant: "convert", revealed } });
  it("matches on position within 5 m", () => {
    expect(revealMatches([{ pos: { lat: pos.lat + 0.00003, lng: pos.lng } }], pos)).toBe(true); // ~3.3 m
    expect(revealMatches([{ pos: { lat: pos.lat + 0.0001, lng: pos.lng } }], pos)).toBe(false); // ~11 m
  });
  it("passes when seen in time, fails when late or never, ignores no-one-looked", () => {
    const w = mk();
    recordHunterView(w, hunter([{ id: "x", pos }]), 1000 + 21_000);
    recordHunterView(w, hunter([]), 1000 + 30_000);
    expect(revealProblem(w)).toBeNull();

    const never = mk();
    recordHunterView(never, hunter([]), 1000 + 30_000);
    expect(revealProblem(never)).toMatch(/aldri/);

    const late = mk();
    recordHunterView(late, hunter([{ id: "x", pos }]), 1000 + 30_000);
    expect(revealProblem(late)).toMatch(/reveal etter/);

    const nobody = mk();
    recordHunterView(nobody, hunter([]), 1000 + 5_000);
    expect(revealProblem(nobody)).toBeNull();
  });
  it("ignores hunters before Gjemsel release and flags a plain player id", () => {
    const w = mk();
    recordHunterView(w, { status: "live", role: "hunter", tag: { variant: "hide", hide: { released: false } } }, 1000 + 40_000);
    expect(w.hunterViewsDue).toBe(0);
    recordHunterView(w, hunter([{ id: "p1", pos }]), 1000 + 21_000, new Set(["p1"]));
    expect(revealProblem(w)).toMatch(/klartekst/);
  });
});

describe("streak and multiplier", () => {
  it("streak must be reset after the locker is back", () => {
    const w = mk();
    expect(streakProblem(w, { live: { on: true, streak_s: 2 } })).toBeNull();
    expect(streakProblem(w, { live: { on: true, streak_s: 130 } })).toMatch(/streak_s/);
    expect(streakProblem(w, { live: { on: true, frozen: true, streak_s: 130 } })).toBeNull();
  });
  it("expectedMult steps with tolerance", () => {
    expect([0, 100, 114].map(expectedMult)).toEqual([1, 1, 1]);
    expect(expectedMult(120)).toBeNull();
    expect([126, 200].map(expectedMult)).toEqual([1.25, 1.25]);
    expect(expectedMult(240)).toBeNull();
    expect(expectedMult(250)).toBe(1.5);
  });
  it("observeView counts bad multipliers and flash posts", () => {
    const ls = newLiveStats();
    observeView(ls, { live: { on: true, mult: 1, streak_s: 50 } });
    observeView(ls, { live: { on: true, mult: 1.25, streak_s: 150 }, posts: [{ id: "a", flash: true }, { id: "b" }] });
    expect(ls.multBad).toBe(0);
    expect([ls.mult125Seen, ls.maxStreakS, ls.flashSeen.size]).toEqual([1, 150, 1]);
    observeView(ls, { live: { on: true, mult: 1, streak_s: 150 } });
    expect(ls.multBad).toBe(1);
    observeView(ls, {});
    expect(ls.viewsWithoutLive).toBe(1);
  });
});

describe("liveRewardsProblems", () => {
  const ctx = { hasHost: true, plan: "posts:240", bots: 20, minutes: 5, alarms: [] as { player: string; kind: string; seenAt: number | null }[], lockers: 0 };
  it("demands the new fields", () => {
    expect(liveRewardsProblems(newLiveStats(), ctx)[0]).toMatch(/mangler 0024/);
  });
  it("passes a healthy run and flags missing flash, signal alarm and locker returns", () => {
    const ls = newLiveStats();
    observeView(ls, { live: { on: true, mult: 1, streak_s: 50 } });
    observeView(ls, { live: { on: true, mult: 1.25, streak_s: 150 }, posts: [{ id: "f", flash: true }] });
    ls.flashClaimed = 1;
    expect(liveRewardsProblems(ls, ctx)).toEqual([]);
    ls.flashClaimed = 0;
    expect(liveRewardsProblems(ls, ctx).join()).toMatch(/ingen ble tatt/);
    ls.flashClaimed = 1;
    const w = mk();
    w.kind = "locker70";
    w.returnedAt = 1000 + 72_000;
    ls.windows.push(w);
    expect(liveRewardsProblems(ls, { ...ctx, lockers: 1 }).join()).toMatch(/signaltap/);
    expect(liveRewardsProblems(ls, { ...ctx, lockers: 1, alarms: [{ player: "p1", kind: "signal", seenAt: 5 }] })).toEqual([]);
  });
  it("judgeWindow aggregates", () => {
    const w = mk();
    w.returnedAt = 41_000;
    expect(judgeWindow(w, { status: "live", round_idx: 0, stats: { points: 11 }, live: { on: true, streak_s: 1 } }, 2)).toEqual([]);
  });
});
