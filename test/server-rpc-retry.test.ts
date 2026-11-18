import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: Array<{ data: unknown; error: { code: string; message: string } | null }> = [];
const rpcMock = vi.fn(async () => calls.shift() ?? { data: null, error: { code: "XX000", message: "no more" } });
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({ rpc: rpcMock }) }));

const { rpc } = await import("@/lib/server/rpc");

describe("rpc retry", () => {
  beforeEach(() => {
    calls.length = 0;
    rpcMock.mockClear();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("retries once after a statement timeout and returns the second answer", async () => {
    calls.push({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } });
    calls.push({ data: { ok: true }, error: null });
    await expect(rpc("host_action", {}, 0)).resolves.toEqual({ ok: true });
    expect(rpcMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after one retry", async () => {
    calls.push({ data: null, error: { code: "55P03", message: "lock timeout" } });
    calls.push({ data: null, error: { code: "55P03", message: "lock timeout" } });
    await expect(rpc("host_action", {}, 0)).rejects.toThrow("rpc_failed:host_action");
    expect(rpcMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry other errors (the call may have had effects)", async () => {
    calls.push({ data: null, error: { code: "P0001", message: "boom" } });
    await expect(rpc("raise_sos", {}, 0)).rejects.toThrow("rpc_failed:raise_sos");
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });
});
