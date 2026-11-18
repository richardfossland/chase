import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { LngLat } from "@/lib/geo";
import { GAME } from "@/lib/rules/game";
import { FIXED_POSTS, fixedPostsOk, fixedQrPresent, newPostCode, normPosts, POSTS_MAX, round6 } from "@/lib/rules/library";

// Same vectors as test/sql/0016_area_posts.test.sql.
describe("fixed posts (0016)", () => {
  it("max matches chase.kg('posts_max')", () => {
    expect(POSTS_MAX).toBe(GAME.posts_max);
  });
  it("normalises", () => {
    expect(normPosts([{ lat: 59.9100004, lng: 10.7509996, name: "  Stor   eik ", qr: true, code: "ab2cd" }])).toEqual([
      { lat: 59.91, lng: 10.751, kind: "normal", qr: true, name: "Stor eik", code: "AB2CD" },
    ]);
    expect(normPosts([{ lat: 59.91, lng: 10.75, name: "   " }])).toEqual([{ lat: 59.91, lng: 10.75, kind: "normal", qr: false }]);
    expect(normPosts(null)).toEqual([]);
    expect(normPosts([])).toEqual([]);
    expect(normPosts([{ lat: 59.91, lng: 10.75, code: "AB2CD" }])).toEqual([{ lat: 59.91, lng: 10.75, kind: "normal", qr: false }]);
  });
  it("rejects", () => {
    expect(normPosts({})).toBeNull();
    expect(normPosts([{ lat: 91, lng: 10 }])).toBeNull();
    expect(normPosts([{ lat: 59, lng: 181 }])).toBeNull();
    expect(normPosts([{ lat: "59", lng: 10 }])).toBeNull();
    expect(normPosts([{ lat: 59, lng: 10, kind: "fast" }])).toBeNull();
    expect(normPosts([{ lat: 59, lng: 10, name: "x".repeat(41) }])).toBeNull();
    expect(normPosts([{ lat: 59, lng: 10, qr: true }])).toBeNull();
    expect(normPosts([{ lat: 59, lng: 10, qr: true, code: "AB0CD" }])).toBeNull();
    expect(
      normPosts([
        { lat: 59, lng: 10, qr: true, code: "AB2CD" },
        { lat: 59, lng: 10.1, qr: true, code: "ab2cd" },
      ]),
    ).toBeNull();
    expect(normPosts(Array.from({ length: 41 }, () => ({ lat: 59, lng: 10 })))).toBeNull();
    expect(normPosts(Array.from({ length: 40 }, () => ({ lat: 59, lng: 10 })))).toHaveLength(40);
  });
  it("rounds half away from zero on the decimal text (7th decimal = 5)", () => {
    expect(round6(59.9100005)).toBe(59.910001);
    expect(round6(10.7509995)).toBe(10.751);
    expect(round6(-10.0000005)).toBe(-10.000001);
    expect(round6(10.0000004)).toBe(10);
    expect(round6(-0.0000001)).toBe(0);
    expect(normPosts([{ lat: 59.9100005, lng: -10.0000005 }])).toEqual([{ lat: 59.910001, lng: -10.000001, kind: "normal", qr: false }]);
  });
  it("posts must be inside the area and clear of blocked areas", () => {
    const area: LngLat[] = [[10.75, 59.91], [10.7518, 59.91], [10.7518, 59.9109], [10.75, 59.9109]];
    const blocked: LngLat[] = [[10.751, 59.9104], [10.7512, 59.9104], [10.7512, 59.9105], [10.751, 59.9105]];
    expect(fixedPostsOk([{ lat: 59.9103, lng: 10.7505 }], area, [blocked])).toBe(true);
    expect(fixedPostsOk([{ lat: 60.5, lng: 10.7505 }], area, [])).toBe(false);
    expect(fixedPostsOk([{ lat: 59.91045, lng: 10.7511 }], area, [blocked])).toBe(false); // inside
    expect(fixedPostsOk([{ lat: 59.91054, lng: 10.7511 }], area, [blocked])).toBe(false); // ~4 m from it
    expect(fixedPostsOk([{ lat: 59.9108, lng: 10.7511 }], area, [blocked])).toBe(true); // ~33 m away
  });
  it("fixed QR presence", () => {
    expect(fixedQrPresent(50, 5, 10)).toBe(true);
    expect(fixedQrPresent(150, 5, 10)).toBe(false);
    expect(fixedQrPresent(150, 200, 10)).toBe(false); // coarse fix (Wi-Fi at home) never counts
    expect(fixedQrPresent(90, 25, 10)).toBe(true); // acc at the limit
    expect(fixedQrPresent(90, 26, 10)).toBe(false);
    expect(fixedQrPresent(50, 5, 60)).toBe(false); // exactly 60 s: rejected, like SQL
    expect(fixedQrPresent(50, 5, 61)).toBe(false); // stale fix
  });
  it("tunables match chase._fx()", () => {
    const sql = readFileSync(new URL("../supabase/migrations/0016_area_posts.sql", import.meta.url), "utf8");
    const from = sql.indexOf("function chase._fx(");
    const body = sql.slice(from, sql.indexOf("end::real;", from));
    const pairs = [...body.matchAll(/when '([a-z0-9_]+)'\s+then ([0-9.]+)/g)].map((m) => [m[1], Number(m[2])] as const);
    expect(Object.fromEntries(pairs)).toEqual(FIXED_POSTS);
  });
  it("makes unique codes in the alphabet", () => {
    const c = newPostCode(["AB2CD"]);
    expect(c).toMatch(/^[A-HJ-NP-Z2-9]{5}$/);
    expect(c).not.toBe("AB2CD");
  });
});
