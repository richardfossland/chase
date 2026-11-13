import { describe, expect, it } from "vitest";
import { BADGES } from "@/lib/rules/game";
import { no } from "@/lib/locale/no";

describe("every badge has a name on the phone", () => {
  it("no raw ids", () => {
    for (const b of BADGES) expect(no.play.badges[b], b).toBeTruthy();
  });
});
