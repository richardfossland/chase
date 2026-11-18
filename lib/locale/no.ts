// All user-facing strings (bokmål). Components import from here — no inline
// Norwegian copy in JSX, so wording can be tuned in one place.

// Split per area in ./no/*.ts.

import { site } from "./no/site";
import { wizard } from "./no/wizard";
import { host } from "./no/host";
import { play } from "./no/play";
import { ceremony } from "./no/ceremony";
import { quiz } from "./no/quiz";
import { teams } from "./no/teams";
import { events } from "./no/events";
import { library } from "./no/library";
import { hotcold } from "./no/hotcold";
import { demo } from "./no/demo";

export const no = {
  ...site,
  ...wizard,
  ...host,
  ...play,
  ...ceremony,
  ...quiz,
  ...teams,
  ...events,
  ...library,
  ...hotcold,
  ...demo,
} as const;
