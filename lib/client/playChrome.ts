// Enkel start (C): what the student screen shows around the one main thing.
// Pure and display-only. Nothing here touches the safety banner (near the edge,
// outside, forbidden zone, GPS lost) or SOS: those are decided in PlayView and
// always win (CLAUDE.md rule 4).

import type { EventView, PowerView, TickView } from "@/lib/client/api";
import type { Badge } from "@/lib/rules/game";

export interface ChromeInput {
  /** The round's mode (`free` when there is none). */
  mode: string;
  /** Tag variant: convert, swap, fox or hide. */
  variant: string | null | undefined;
  /** A team round (flag, king, or «som lag»). */
  teamRound: boolean;
  /** The server has sent an event or I hold/run a power-up: the plan has events. */
  hasEvents: boolean;
}

export interface Chrome {
  /** Meters and steps in the header: Postjakt only. */
  headerStats: boolean;
  eventStrip: boolean;
  powerBar: boolean;
  hotCold: boolean;
  teamStrip: boolean;
  teamMsgBar: boolean;
}

export function playChrome(i: ChromeInput): Chrome {
  return {
    headerStats: i.mode === "posts",
    eventStrip: i.hasEvents,
    powerBar: i.hasEvents,
    hotCold: i.mode === "tag" && !!i.variant && i.variant !== "convert",
    teamStrip: i.teamRound,
    teamMsgBar: i.teamRound,
  };
}

/**
 * The tick has no plan, so «the plan has events» is read from what the server
 * sent: an event on the phone, or power-ups in the bag or running. With
 * `event_every_s` off and no teacher-started event, none of it exists.
 */
export function hasEventsOn(event: EventView | null | undefined, power: PowerView | null | undefined): boolean {
  if (event) return true;
  if (!power) return false;
  return power.inv.length > 0 || !!power.radar_until || !!power.turbo_until || !!power.decoy_until;
}

export interface SessionTotals {
  distance_m: number;
  active_s: number;
  posts: number;
  badges: Badge[];
}

/** Whole-session totals for the result card: the server's own running stats, nothing stored on the device. */
export function sessionTotals(stats: TickView["stats"] | null | undefined): SessionTotals {
  return {
    distance_m: Math.max(0, Math.round(stats?.distance_m ?? 0)),
    active_s: Math.max(0, Math.floor(stats?.active_s ?? 0)),
    posts: Math.max(0, Math.floor(stats?.posts ?? 0)),
    badges: stats?.badges ?? [],
  };
}
