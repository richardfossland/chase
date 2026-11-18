import { describe, expect, it } from "vitest";
import { GAME } from "@/lib/rules/game";
import { newPostCode, normPosts, POSTS_MAX } from "@/lib/rules/library";

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
  it("makes unique codes in the alphabet", () => {
    const c = newPostCode(["AB2CD"]);
    expect(c).toMatch(/^[A-HJ-NP-Z2-9]{5}$/);
    expect(c).not.toBe("AB2CD");
  });
});
