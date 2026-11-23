import { describe, expect, it } from "vitest";

import type { LiveView, PostView } from "@/lib/client/api";
import {
  awayBody, awayIds, awayUrl, bestStreakS, flashLeftS, hunterAlert, isAway, liveWarning, multLabel,
  newFlashPosts, revealedForMap, ringFraction, ringTone, shouldSendAway, showLiveRing, soonestFlash, warnLeftS,
} from "@/lib/client/liveRing";

const live = (o: Partial<LiveView> = {}): LiveView => ({ on: true, mult: 1, streak_s: 0, next_s: 120, frozen: false, ...o });
const post = (o: Partial<PostView>): PostView => ({ id: "p", pos: { lat: 1, lng: 1 }, value: 25, kind: "normal", expires_at: null, ...o });

describe("live ring", () => {
  it("shows only with live and an active round", () => {
    expect(showLiveRing(undefined, "live")).toBe(false);
    expect(showLiveRing(live(), "lobby")).toBe(false);
    expect(showLiveRing(live(), "countdown")).toBe(false);
    expect(showLiveRing(live(), "live")).toBe(true);
    expect(showLiveRing(live({ frozen: true }), "paused")).toBe(true);
  });
  it("fills toward the next step, per step", () => {
    expect(ringFraction(live({ streak_s: 60, next_s: 60 }))).toBeCloseTo(0.5);
    expect(ringFraction(live({ mult: 1.25, streak_s: 180, next_s: 60 }))).toBeCloseTo(0.5);
    expect(ringFraction(live({ mult: 1.5, streak_s: 400, next_s: null }))).toBe(1);
    expect(ringFraction(live({ streak_s: 0, next_s: 120 }))).toBe(0);
  });
  it("labels the multiplier with a comma, none at x1", () => {
    expect(multLabel(1)).toBeNull();
    expect(multLabel(1.25)).toBe("×1,25");
    expect(multLabel(1.5)).toBe("×1,5");
  });
  it("is grey when frozen", () => {
    expect(ringTone(live({ frozen: true }), "paused")).toBe("frozen");
    expect(ringTone(live(), "breather")).toBe("frozen");
    expect(ringTone(live(), "live")).toBe("on");
    expect(ringTone(live({ on: false }), "live")).toBe("off");
  });
});

describe("liveWarning", () => {
  const base = { fixAgeS: 12, status: "live" as const, live: live(), tag: null, role: "free" };
  it("warns the streak between 10 s and 20 s", () => {
    expect(liveWarning(base)).toBe("streak");
    expect(liveWarning({ ...base, fixAgeS: 10 })).toBeNull();
    expect(liveWarning({ ...base, fixAgeS: 21 })).toBeNull();
    expect(liveWarning({ ...base, fixAgeS: Infinity })).toBeNull();
  });
  it("warns visibility for prey, not before the hide release", () => {
    expect(liveWarning({ ...base, tag: { variant: "convert" }, role: "prey" })).toBe("reveal");
    expect(liveWarning({ ...base, tag: { variant: "hide" }, role: "prey", hidePending: true })).toBe("streak");
    expect(liveWarning({ ...base, tag: { variant: "convert" }, role: "hunter" })).toBe("streak");
  });
  it("is silent outside an active round, when frozen or not counting", () => {
    expect(liveWarning({ ...base, status: "paused" })).toBeNull();
    expect(liveWarning({ ...base, status: "breather" })).toBeNull();
    expect(liveWarning({ ...base, live: live({ frozen: true }) })).toBeNull();
    expect(liveWarning({ ...base, live: live({ on: false }) })).toBeNull();
    expect(liveWarning({ ...base, live: undefined })).toBeNull();
  });
  it("counts down to the streak break", () => {
    expect(warnLeftS(10.2)).toBe(10);
    expect(warnLeftS(19.5)).toBe(1);
    expect(warnLeftS(25)).toBe(0);
  });
});

describe("away beacon", () => {
  const ok = { ready: true, ended: false, kicked: false, status: "live" as const, lastSentAt: null, nowMs: 100_000 };
  it("sends in an active session", () => expect(shouldSendAway(ok)).toBe(true));
  it("does not send before ready, after end, or in lobby/ceremony", () => {
    expect(shouldSendAway({ ...ok, ready: false })).toBe(false);
    expect(shouldSendAway({ ...ok, ended: true })).toBe(false);
    expect(shouldSendAway({ ...ok, kicked: true })).toBe(false);
    expect(shouldSendAway({ ...ok, status: "lobby" })).toBe(false);
    expect(shouldSendAway({ ...ok, status: "ceremony" })).toBe(false);
  });
  it("rate limits back-to-back events", () => {
    expect(shouldSendAway({ ...ok, lastSentAt: 98_000 })).toBe(false);
    expect(shouldSendAway({ ...ok, lastSentAt: 90_000 })).toBe(true);
  });
  it("keeps the token in the body, never the URL", () => {
    expect(awayUrl("abc")).toBe("/api/s/abc/away");
    expect(awayUrl("abc")).not.toContain("tok");
    expect(JSON.parse(awayBody("tok123"))).toEqual({ token: "tok123" });
  });
});

describe("flash posts", () => {
  it("finds new unclaimed flash posts only", () => {
    const posts = [post({ id: "a" }), post({ id: "b", flash: true }), post({ id: "c", flash: true, claimed_by: "x" }), post({ id: "d", flash: true })];
    expect(newFlashPosts(posts, new Set(["d"])).map((p) => p.id)).toEqual(["b"]);
    expect(newFlashPosts(null, new Set())).toEqual([]);
  });
  it("counts down on the server clock, never negative", () => {
    const exp = new Date(100_000 + 12_300).toISOString();
    expect(flashLeftS(exp, 100_000, 0)).toBe(13);
    expect(flashLeftS(exp, 100_000, 5_000)).toBe(8);
    expect(flashLeftS(exp, 200_000, 0)).toBe(0);
    expect(flashLeftS(null, 0, 0)).toBeNull();
  });
  it("picks the soonest live flash", () => {
    const a = post({ id: "a", flash: true, expires_at: new Date(130_000).toISOString() });
    const b = post({ id: "b", flash: true, expires_at: new Date(110_000).toISOString() });
    const gone = post({ id: "c", flash: true, expires_at: new Date(90_000).toISOString() });
    expect(soonestFlash([a, b, gone], 100_000, 0)?.post.id).toBe("b");
    expect(soonestFlash([post({})], 100_000, 0)).toBeNull();
  });
});

describe("revealed, hunter alert, teacher", () => {
  it("rounds ages and sorts freshest first", () => {
    const r = revealedForMap([
      { id: "1", pos: { lat: 1, lng: 1 }, age_s: 40.4 },
      { id: "2", pos: { lat: 2, lng: 2 }, age_s: 21.6 },
    ]);
    expect(r.map((x) => x.age_s)).toEqual([22, 40]);
    expect(revealedForMap(undefined)).toEqual([]);
  });
  it("close beats near; immune gets none", () => {
    expect(hunterAlert({ hunter_near: true, hunter_close: true }, false)).toBe("close");
    expect(hunterAlert({ hunter_near: true }, false)).toBe("near");
    expect(hunterAlert({ hunter_near: true, hunter_close: true }, true)).toBeNull();
    expect(hunterAlert(null, false)).toBeNull();
  });
  it("away flags tolerate old servers", () => {
    expect(isAway({})).toBe(false);
    expect(isAway({ away: true })).toBe(true);
    expect([...awayIds([{ id: "a", away: true }, { id: "b" }])]).toEqual(["a"]);
  });
  it("best streak only when present and positive", () => {
    expect(bestStreakS({})).toBeNull();
    expect(bestStreakS({ best_streak_s: 0 })).toBeNull();
    expect(bestStreakS({ best_streak_s: 187.9 })).toBe(187);
  });
});
