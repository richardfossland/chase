import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({}) }));
vi.mock("@/lib/server/rpc", async (orig) => ({ ...(await orig<typeof import("@/lib/server/rpc")>()), rpc: (...a: unknown[]) => rpc(...a) }));

import { POST } from "@/app/api/s/[id]/away/route";
import { sha256Hex } from "@/lib/server/tokens";

const ID = "11111111-2222-4333-8444-555555555555";
const TOKEN = "A".repeat(43);
const call = (id: string, body: unknown, raw = false) =>
  POST(new Request(`https://x/api/s/${id}/away`, { method: "POST", body: raw ? (body as string) : JSON.stringify(body) }), { params: Promise.resolve({ id }) });

describe("POST /api/s/[id]/away", () => {
  beforeEach(() => rpc.mockReset());

  it("hashes the body token, calls mark_away and returns 204", async () => {
    rpc.mockResolvedValue({ ok: true });
    const res = await call(ID, { token: TOKEN });
    expect(res.status).toBe(204);
    expect(rpc).toHaveBeenCalledWith("mark_away", { p_session: ID, p_token_hash: await sha256Hex(TOKEN) });
  });
  it("400 on a bad id, bad json or a bad token shape; never calls the rpc", async () => {
    expect((await call("nope", { token: TOKEN })).status).toBe(400);
    expect((await call(ID, "{", true)).status).toBe(400);
    expect((await call(ID, { token: "short" })).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("400 when the rpc refuses the token", async () => {
    rpc.mockResolvedValue({ ok: false, error: "auth" });
    expect((await call(ID, { token: "B".repeat(43) })).status).toBe(400);
  });
});
