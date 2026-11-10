import { describe, expect, it } from "vitest";
import { normCode, parseQr, qrUrl } from "@/lib/qr";

const S = "6c760c64-f172-4100-9d95-5d60b3c202c2";

describe("QR cards", () => {
  it("round-trips the URL", () => {
    expect(qrUrl("https://chase.sundaysuite.app/", S, "AB2CD")).toBe(`https://chase.sundaysuite.app/q/${S}/AB2CD`);
    expect(parseQr(qrUrl("https://x.test", S, "AB2CD"), S)).toBe("AB2CD");
  });
  it("rejects another session's card", () => {
    expect(parseQr(qrUrl("https://x.test", "00000000-0000-4000-8000-000000000000", "AB2CD"), S)).toBeNull();
  });
  it("accepts typed codes, tolerant of case and spaces", () => {
    expect(parseQr(" ab2cd ", S)).toBe("AB2CD");
    expect(parseQr("AB-2CD", S)).toBe("AB2CD");
    expect(normCode("ab 2cd")).toBe("AB2CD");
  });
  it("rejects ambiguous letters and junk", () => {
    expect(parseQr("AB0CD", S)).toBeNull(); // 0 is not in the alphabet
    expect(parseQr("https://example.com", S)).toBeNull();
  });
});
