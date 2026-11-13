import type { Plan } from "@/lib/rules/game";
import { planTotalS } from "@/lib/rules/game";
import { no } from "@/lib/locale/no";

/** «Postjakt · Flaggjakt · Smittejakt» + «ca. 31 min» for lists and previews. */
export function planSummary(plan: Plan): { modes: string; minutes: number } {
  const m = no.wizard.playlist.modes;
  const modes = plan.rounds.map((r) => (r.mode === "tag" ? m[r.variant ?? "convert"] : m[r.mode])).join(" · ");
  return { modes, minutes: Math.round(planTotalS(plan) / 60) };
}
