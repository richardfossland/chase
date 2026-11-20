// Rene hjelpere for lærerpanelet («enkel start»): hva planen faktisk bruker.
// Bare UI-valg; serveren støtter alt uansett.

import type { Plan } from "@/lib/rules/game";

type PlanLike = Pick<Plan, "rounds" | "event_every_s" | "teams"> | null | undefined;

/** Overraskelser er slått på i planen (event_every_s > 0). */
export function planHasEvents(plan: PlanLike): boolean {
  return (plan?.event_every_s ?? 0) > 0;
}

/** Minst én lagrunde: egen lag-bryter, eller flagg/konge/stafett som alltid er lag. */
export function planHasTeamRound(plan: PlanLike): boolean {
  if (!plan) return false;
  if ((plan.teams ?? 0) >= 2) return true;
  return (plan.rounds ?? []).some((r) => r.team === true || r.mode === "flag" || r.mode === "king" || r.mode === "relay");
}
