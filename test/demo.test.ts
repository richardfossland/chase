import { describe, expect, it } from "vitest";

import { clampBots, DEMO_MAX_BOTS, DEMO_MIN_BOTS } from "@/lib/client/demoBots";
import { demoKeys, demoSalt, normalizeIp, sessionFlags, simKeyOk } from "@/lib/server/demo";
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
  it("nøkler er HMAC (saltet), og lærernøkkel kommer bare med når den finnes", async () => {
    const salt = "s".repeat(24);
    const a = await demoKeys(salt, "1.2.3.4");
    const b = await demoKeys(salt, "1.2.3.4", "ABCD");
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(2);
    expect(a[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(b[0]).toBe(a[0]);
    expect((await demoKeys("t".repeat(24), "1.2.3.4"))[0]).not.toBe(a[0]);
  });
  it("IPv6 normaliseres til /64", async () => {
    expect(normalizeIp("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe(normalizeIp("2001:0db8:0001:0002::1"));
    expect(normalizeIp("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(normalizeIp("2001:db8:1:3::1")).not.toBe(normalizeIp("2001:db8:1:2::1"));
    expect(normalizeIp("::ffff:10.0.0.1")).toBe("10.0.0.1");
    expect(normalizeIp("10.0.0.1")).toBe("10.0.0.1");
    const s = "s".repeat(24);
    expect(await demoKeys(s, "2001:db8:1:2::5")).toEqual(await demoKeys(s, "2001:db8:1:2::9999"));
  });
  it("demo er avslått i prod uten DEMO_SALT, men har testverdi i dev", () => {
    expect(demoSalt({ NODE_ENV: "production" })).toBeNull();
    expect(demoSalt({ NODE_ENV: "production", DEMO_SALT: "x".repeat(20) })).toBe("x".repeat(20));
    expect(demoSalt({ NODE_ENV: "development" })).toBeTruthy();
  });
  it("grense og travelhet gir 429 og 503", () => {
    expect(statusFor("demo_limit")).toBe(429);
    expect(statusFor("demo_busy")).toBe(503);
    expect(statusFor("demo_off")).toBe(503);
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
