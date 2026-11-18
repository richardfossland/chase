import { describe, expect, it } from "vitest";

import { clampBots, DEMO_MAX_BOTS, DEMO_MIN_BOTS } from "@/lib/client/demoBots";
import { demoKeys, sessionFlags, simKeyOk } from "@/lib/server/demo";
import { createSessionBody } from "@/lib/server/schemas";
import { statusFor } from "@/lib/server/rpc";

const KEY = "k".repeat(32);

describe("simKeyOk", () => {
  it("krever riktig nøkkel og ignorerer tom eller for kort secret", () => {
    expect(simKeyOk({ SIM_KEY: KEY }, KEY)).toBe(true);
    expect(simKeyOk({ SIM_KEY: KEY }, "x".repeat(32))).toBe(false);
    expect(simKeyOk({ SIM_KEY: KEY }, null)).toBe(false);
    expect(simKeyOk({}, KEY)).toBe(false);
    expect(simKeyOk({ SIM_KEY: "kort" }, "kort")).toBe(false);
  });
});

describe("sessionFlags", () => {
  it("sim ignoreres i prod uten SIM_ENABLED og uten nøkkel", () => {
    expect(sessionFlags({ sim: true }, {}, null)).toEqual({ isSim: false, demo: false });
    expect(sessionFlags({ sim: true }, { SIM_KEY: KEY }, "feil")).toEqual({ isSim: false, demo: false });
  });
  it("sim gjelder med SIM_ENABLED=1 eller riktig x-sim-key", () => {
    expect(sessionFlags({ sim: true }, { SIM_ENABLED: "1" }, null).isSim).toBe(true);
    expect(sessionFlags({ sim: true }, { SIM_KEY: KEY }, KEY).isSim).toBe(true);
  });
  it("nøkkelen alene merker ikke økter som ikke ber om sim", () => {
    expect(sessionFlags({}, { SIM_KEY: KEY }, KEY)).toEqual({ isSim: false, demo: false });
  });
  it("demo gir is_sim uten SIM_ENABLED", () => {
    expect(sessionFlags({ demo: true }, {}, null)).toEqual({ isSim: true, demo: true });
  });
});

describe("demo-vern", () => {
  it("nøkler er hashet og inkluderer lærernøkkel bare når den finnes", async () => {
    const a = await demoKeys("1.2.3.4");
    const b = await demoKeys("1.2.3.4", "ABCD");
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(2);
    expect(a[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(b[0]).toBe(a[0]);
  });
  it("grense og travelhet gir 429 og 503", () => {
    expect(statusFor("demo_limit")).toBe(429);
    expect(statusFor("demo_busy")).toBe(503);
  });
  it("antall boter holdes mellom 8 og 20", () => {
    expect(clampBots(3)).toBe(DEMO_MIN_BOTS);
    expect(clampBots(500)).toBe(DEMO_MAX_BOTS);
    expect(clampBots(12)).toBe(12);
    expect(clampBots(NaN)).toBe(12);
  });
  it("schema godtar demo", () => {
    const sq = { type: "Polygon", coordinates: [[[10.75, 59.91], [10.7518, 59.91], [10.7518, 59.9109], [10.75, 59.91]]] };
    expect(createSessionBody.safeParse({ boundary: sq, assembly: { type: "Point", coordinates: [10.75, 59.91] }, demo: true }).success).toBe(true);
  });
});
