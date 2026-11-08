import { describe, expect, it } from "vitest";

import type { HostAlarm } from "@/lib/client/api";
import { groupAlarms } from "@/app/host/[id]/HostPanel";

const base = { nickname: "Siri", pos: null, created_at: "", level: 1 };
const al = (id: string, player: string, kind: HostAlarm["kind"], acked: boolean, resolved: boolean, level = 2): HostAlarm => ({
  ...base,
  id,
  player_id: player,
  kind,
  acked,
  resolved,
  level,
});

describe("groupAlarms", () => {
  it("merges re-entries per pupil and kind; ack covers all unacked", () => {
    const g = groupAlarms([al("a", "p1", "forbidden", false, false), al("b", "p1", "forbidden", false, true), al("c", "p2", "forbidden", false, false)]);
    expect(g).toHaveLength(2);
    expect(g[0].ids).toEqual(["a", "b"]);
    expect(g[0].a.resolved).toBe(false); // still ongoing → not "over"
  });
  it("keeps different kinds apart and a group urgent if any member is unacked", () => {
    const g = groupAlarms([al("s", "p1", "sos", false, false), al("o", "p1", "outside", true, false), al("o2", "p1", "outside", false, true)]);
    expect(g.map((x) => x.a.kind)).toEqual(["sos", "outside"]);
    expect(g[1].a.acked).toBe(false);
    expect(g[1].ids).toEqual(["o2"]);
  });
});
