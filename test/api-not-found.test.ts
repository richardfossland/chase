import { describe, expect, it } from "vitest";

import { GET, POST } from "@/app/api/[...missing]/route";

describe("/api/[...missing] catch-all", () => {
  it("GET returns JSON 404, not an HTML not-found page", async () => {
    const res = await GET();
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    await expect(res.json()).resolves.toEqual({ error: "not_found" });
  });

  it("POST also returns JSON 404", async () => {
    const res = await POST();
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "not_found" });
  });
});
