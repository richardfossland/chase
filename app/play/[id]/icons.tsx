// Extra line icons for the phone screens (same 24 px grid, 2 px stroke, round caps as
// lib/client/ui/icons.tsx). Plus the lookup tables that replace the emoji that used to
// live in the locale strings: the JSX puts the icon, the string is text only.

import {
  IconAlert,
  IconCheck,
  IconClock,
  IconCrown,
  IconDumbbell,
  IconFlag,
  IconHelp,
  IconMap,
  IconMapPin,
  IconQr,
  IconRadar,
  IconRepeat,
  IconShield,
  IconShrink,
  IconStar,
  IconTarget,
  IconUsers,
  IconZap,
  icon,
} from "@/lib/client/ui/icons";

export type Icon = ReturnType<typeof icon>;

/** Fox head: ears, cheeks, snout. */
export const IconFox = icon(<path d="M4 4l4 5h8l4-5 0 8-8 8-8-8V4zM9.5 13v.5M14.5 13v.5M11 16.5h2" />);
/** Relay baton, held at an angle. */
export const IconBaton = icon(
  <>
    <rect x="9" y="2.5" width="6" height="19" rx="3" transform="rotate(35 12 12)" />
    <path d="M8.2 9.3l7.6 5.4" />
  </>,
);
/** Medal on a ribbon. */
export const IconMedal = icon(
  <>
    <path d="M8 3l3 7M16 3l-3 7" />
    <circle cx="12" cy="15" r="5" />
    <path d="M12 13v4" />
  </>,
);
/** Water drop (Pustepause). */
export const IconDrop = icon(<path d="M12 3s6 6.5 6 11a6 6 0 01-12 0c0-4.5 6-11 6-11z" />);
/** Crescent moon (blackout: the radar goes dark). */
export const IconMoon = icon(<path d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z" />);
/** Two footprints (step counter). */
export const IconSteps = icon(
  <>
    <path d="M7 3c1.7 0 2.5 2 2.5 4.5S8.7 12 7 12s-2.5-2-2.5-4.5S5.3 3 7 3zM5 15h4v2a2 2 0 01-4 0v-2z" />
    <path d="M17 7c1.7 0 2.5 2 2.5 4.5S18.7 16 17 16s-2.5-2-2.5-4.5S15.3 7 17 7zM15 19h4v.5a2 2 0 01-4 0V19z" />
  </>,
);
/** Compass rose (explorer). */
export const IconCompass = icon(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M15.5 8.5l-2 5-5 2 2-5 5-2z" />
  </>,
);
/** Running shoe (distance). */
export const IconShoe = icon(<path d="M3 17v-6l4-1 2 3 4-1 6 2a2 2 0 012 2v1H3zM3 17v2h18v-2" />);

/* ── lookups: emoji in the old strings → an icon in the JSX ── */

export const EVENT_ICONS: Record<string, Icon> = {
  sprint: IconFlag,
  mission: IconDumbbell,
  gather: IconUsers,
  golden: IconStar,
  storm: IconRepeat,
  blackout: IconMoon,
};

export const POWERUP_ICONS: Record<string, Icon> = {
  shield: IconShield,
  radar: IconRadar,
  decoy: IconTarget,
  turbo: IconZap,
};

export const TEAM_MSG_ICONS: Record<string, Icon> = {
  help: IconAlert,
  come: IconMapPin,
  mine: IconFlag,
  ok: IconCheck,
};

export const BADGE_ICONS: Record<string, Icon> = {
  first_post: IconMapPin,
  golden: IconStar,
  posts_5: IconMapPin,
  qr: IconQr,
  km_1: IconShoe,
  active_10: IconClock,
  explorer_25: IconCompass,
  first_catch: IconTarget,
  catches_5: IconTarget,
  survivor: IconShield,
  zone_master: IconShrink,
  m500: IconShoe,
  active_5: IconClock,
  explorer_10: IconMap,
  catch_3: IconTarget,
  survived_60: IconShield,
  sprint: IconFlag,
  mission: IconDumbbell,
  gathered: IconUsers,
  quiz: IconHelp,
  powerup: IconZap,
  flag: IconFlag,
  hill: IconCrown,
  fox: IconFox,
  relay: IconBaton,
};
