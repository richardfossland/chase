// Curated start packs (PLAN §13 fase 6, owner's choice 2026-11-12): a ready
// playlist, own missions that fit the place, and an area suggestion — a circle
// of the given radius around where the teacher stands (areas are always
// local). test/library.test.ts checks every pack against normPlan.

import type { Plan } from "@/lib/rules/game";
import { GAME } from "@/lib/rules/game";

export interface StarterPack {
  id: "skolegard" | "skog" | "sentrum" | "kirkeleir";
  name: string;
  emoji: string;
  lead: string;
  /** Suggested circle around the teacher, metres. */
  radius_m: number;
  /** What to check / draw before starting. */
  tips: string[];
  plan: Plan;
}

const base = { countdown_s: GAME.countdown_s, breather_s: GAME.breather_s, qr_posts: 0, event_every_s: 90 } as const;

export const STARTER_PACKS: StarterPack[] = [
  {
    id: "skolegard",
    name: "Skolegården",
    emoji: "🏫",
    lead: "En hel gymtime på skolens eget område. Korte runder og mange poster, så alle kommer i gang.",
    radius_m: 70,
    tips: ["Tegn sykkelstativ, parkering og innganger som forbudte soner.", "Samlingspunktet ved inngangsdøra er lett å finne."],
    plan: {
      ...base,
      rounds: [
        { mode: "free", duration_s: 180 },
        { mode: "posts", duration_s: 360 },
        { mode: "tag", duration_s: 300, variant: "convert" },
        { mode: "posts", duration_s: 300, zone: true },
        { mode: "tag", duration_s: 300, variant: "swap" },
      ],
      missions: ["10 sprellemenn ved nærmeste vegg", "Løp en runde rundt nærmeste tre eller stolpe", "10 knebøy", "Balanser på ett bein i 20 sekunder", "5 utfall på hvert bein"],
    },
  },
  {
    id: "skog",
    name: "Skogen",
    emoji: "🌲",
    lead: "Større område, lengre runder og lag. Flaggjakt passer godt mellom trærne.",
    radius_m: 150,
    tips: ["Gå rundt grensa selv først – elevene skal se den.", "Merk bekker, bratte skrenter og vei som forbudte soner.", "Avtal fløyte som samlingssignal i tillegg til mobilen."],
    plan: {
      ...base,
      teams: 3,
      rounds: [
        { mode: "posts", duration_s: 480, team: true },
        { mode: "flag", duration_s: 600 },
        { mode: "tag", duration_s: 360, variant: "convert" },
        { mode: "king", duration_s: 480 },
      ],
      missions: ["Finn en kongle og vis læreren", "Hopp over 5 røtter eller steiner", "Løp til nærmeste store tre og tilbake", "10 knebøy med armene over hodet", "Plank i 20 sekunder på mosen"],
    },
  },
  {
    id: "sentrum",
    name: "Park i sentrum",
    emoji: "🏙️",
    lead: "En park eller et torg uten biltrafikk. Postjakt og krympende sone holder alle samlet.",
    radius_m: 100,
    tips: ["Bare områder uten biltrafikk – tegn alle gater som forbudte soner.", "Lær elevene «se opp, ikke ned» før dere starter.", "Kortere runder: det er flere folk rundt dere."],
    plan: {
      ...base,
      breather_s: 60,
      rounds: [
        { mode: "posts", duration_s: 300 },
        { mode: "posts", duration_s: 300, zone: true },
        { mode: "tag", duration_s: 300, variant: "swap", zone: true },
      ],
      missions: ["10 sprellemenn", "Gå baklengs 20 skritt (se deg over skulderen!)", "10 hopp med samla bein", "Strekk deg mot himmelen i 10 sekunder"],
    },
  },
  {
    id: "kirkeleir",
    name: "Leir",
    emoji: "⛺",
    lead: "Kirkeleir eller ungdomsleir: lag mot lag, oppdrag og en lang avslutning med Konge på haugen.",
    radius_m: 130,
    tips: ["Tegn vann, brygge og parkering som forbudte soner.", "Lederne kan være dommere – gjør dem til dommer på spillerkortet.", "Del opp i 4 lag så alle blir kjent på tvers."],
    plan: {
      ...base,
      teams: 4,
      event_every_s: 120,
      rounds: [
        { mode: "posts", duration_s: 480, team: true },
        { mode: "flag", duration_s: 600 },
        { mode: "king", duration_s: 600 },
      ],
      missions: ["Hele laget samlet: tell til 20 sammen", "Finn noen fra et annet lag og gi en high five", "10 sprellemenn", "Lag en menneskekjede med noen fra laget", "Syng et refreng høyt"],
    },
  },
];

export function starterPack(id: string): StarterPack | null {
  return STARTER_PACKS.find((p) => p.id === id) ?? null;
}
