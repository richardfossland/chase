// enkel start (B): which round kinds the wizard shows by default. The rest sit behind
// «Flere moduser». Nothing is removed: saved and shared plans play as before.

import type { Plan, PlanRound } from "./game";

export const ROUND_KINDS = ["posts", "convert", "hide", "flag", "swap", "fox", "free", "king", "relay", "scoreo"] as const;
export type Kind = (typeof ROUND_KINDS)[number];

/** Shown by default: Postjakt, Smittejakt, Gjemsel, Flaggjakt. */
export const VISIBLE_KINDS: readonly Kind[] = ["posts", "convert", "hide", "flag"];

export function kindOf(r: Pick<PlanRound, "mode" | "variant">): Kind {
  return r.mode === "tag" ? (r.variant ?? "convert") : (r.mode as Kind);
}

/** True when any round uses a mode or variant that is hidden behind «Flere moduser». */
export function usesHiddenModes(plan: Pick<Plan, "rounds">): boolean {
  return plan.rounds.some((r) => !VISIBLE_KINDS.includes(kindOf(r)));
}
