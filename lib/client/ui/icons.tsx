// Shared line icons (24 px grid, 2 px stroke, currentColor). No "use client":
// usable from server components too. The UI uses these instead of emoji.
// Need one that is missing? Add it to an `icons.tsx` in your own folder with
// `icon()` from here — keep the same grid, stroke and round caps.

import type { ReactNode, SVGProps } from "react";

export type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & { size?: number };

export function icon(paths: ReactNode) {
  return function Icon({ size = 20, ...rest }: IconProps) {
    return (
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        {...rest}
      >
        {paths}
      </svg>
    );
  };
}

/* ── navigation / actions ── */
export const IconPlus = icon(<path d="M12 5v14M5 12h14" />);
export const IconX = icon(<path d="M6 6l12 12M18 6L6 18" />);
export const IconCheck = icon(<path d="M5 12.5l4.5 4.5L19 7.5" />);
export const IconChevronDown = icon(<path d="M6 9l6 6 6-6" />);
export const IconChevronRight = icon(<path d="M9 6l6 6-6 6" />);
export const IconChevronLeft = icon(<path d="M15 6l-6 6 6 6" />);
export const IconArrowRight = icon(<path d="M5 12h14M13 6l6 6-6 6" />);
export const IconArrowLeft = icon(<path d="M19 12H5M11 6l-6 6 6 6" />);
export const IconArrowUp = icon(<path d="M12 19V5M6 11l6-6 6 6" />);
export const IconArrowDown = icon(<path d="M12 5v14M6 13l6 6 6-6" />);
export const IconUndo = icon(<path d="M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3" />);
export const IconRepeat = icon(<path d="M17 2l4 4-4 4M3 11V9a3 3 0 013-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 01-3 3H3" />);
export const IconMore = icon(
  <>
    <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />
  </>,
);
export const IconSearch = icon(
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.5-3.5" />
  </>,
);
export const IconPencil = icon(<path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" />);
export const IconTrash = icon(<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5" />);
export const IconCopy = icon(
  <>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V6a2 2 0 012-2h9" />
  </>,
);
export const IconLink = icon(<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1" />);
export const IconShare = icon(<path d="M12 15V3M7 8l5-5 5 5M5 13v6a2 2 0 002 2h10a2 2 0 002-2v-6" />);
export const IconDownload = icon(<path d="M12 3v12M7 10l5 5 5-5M5 21h14" />);
export const IconPrinter = icon(
  <>
    <path d="M7 9V3h10v6M7 18H5a2 2 0 01-2-2v-5a2 2 0 012-2h14a2 2 0 012 2v5a2 2 0 01-2 2h-2" />
    <rect x="7" y="14" width="10" height="7" />
  </>,
);
export const IconInfo = icon(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 7.5v.5" />
  </>,
);
export const IconAlert = icon(<path d="M12 3L2 20h20L12 3zM12 10v4M12 17v.5" />);

/* ── playback ── */
export const IconPlay = icon(<path d="M7 4.5v15l12-7.5-12-7.5z" fill="currentColor" />);
export const IconPause = icon(<path d="M8 5v14M16 5v14" />);
export const IconStop = icon(<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" />);
export const IconSkip = icon(<path d="M5 5v14l10-7L5 5zM19 5v14" />);
export const IconClock = icon(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </>,
);

/* ── map ── */
export const IconMapPin = icon(
  <>
    <path d="M12 21s7-6.2 7-11.5A7 7 0 005 9.5C5 14.8 12 21 12 21z" />
    <circle cx="12" cy="9.5" r="2.5" />
  </>,
);
export const IconLocate = icon(
  <>
    <circle cx="12" cy="12" r="6" />
    <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
  </>,
);
export const IconCircle = icon(
  <>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
  </>,
);
export const IconShape = icon(<path d="M5 8l8-4 7 6-3 9H7L5 8z" />);
export const IconMap = icon(<path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14" />);
export const IconBan = icon(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M5.6 5.6l12.8 12.8" />
  </>,
);
export const IconFlag = icon(<path d="M5 21V4M5 4h12l-2 4 2 4H5" />);
export const IconShrink = icon(
  <>
    <circle cx="12" cy="12" r="9" strokeDasharray="3 3" />
    <circle cx="12" cy="12" r="4" />
  </>,
);

/* ── people / game ── */
export const IconUser = icon(
  <>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21a8 8 0 0116 0" />
  </>,
);
export const IconUsers = icon(
  <>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M2 20a7 7 0 0114 0M16 4.6a3.5 3.5 0 010 6.8M18 14.5a7 7 0 014 5.5" />
  </>,
);
export const IconTrophy = icon(<path d="M8 4h8v6a4 4 0 01-8 0V4zM8 6H4v1a4 4 0 004 4M16 6h4v1a4 4 0 01-4 4M12 14v4M8 21h8M10 18h4" />);
export const IconCrown = icon(<path d="M3 8l4 4 5-7 5 7 4-4-2 11H5L3 8z" />);
export const IconStar = icon(<path d="M12 3l2.7 5.6 6.1.8-4.5 4.3 1.1 6.1L12 16.9 6.6 19.8l1.1-6.1L3.2 9.4l6.1-.8L12 3z" />);
export const IconZap = icon(<path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" />);
export const IconShield = icon(<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z" />);
export const IconTarget = icon(
  <>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="5" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
  </>,
);
export const IconRadar = icon(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 12l6-6M12 3v3" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
  </>,
);
export const IconEye = icon(
  <>
    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
  </>,
);
export const IconEyeOff = icon(<path d="M3 3l18 18M10.6 5.1A10 10 0 0112 5c6.4 0 10 7 10 7a17 17 0 01-3.2 4M6.5 6.6A17 17 0 002 12s3.6 7 10 7a10 10 0 004.5-1.1M9.9 9.9a3 3 0 004.2 4.2" />);
export const IconHelp = icon(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.5 9.5a2.5 2.5 0 114 2c-.9.6-1.5 1.1-1.5 2.2M12 17v.5" />
  </>,
);
export const IconDumbbell = icon(<path d="M3 9v6M6 6v12M18 6v12M21 9v6M6 12h12" />);
export const IconMove = icon(<path d="M4 12h12M12 6l6 6-6 6M20 5v14" />);

/* ── devices / comms ── */
export const IconQr = icon(
  <>
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <path d="M14 14h3v3h-3zM20 14v.5M20 18v3M14 20.5v.5M17 20h.5" />
  </>,
);
export const IconCamera = icon(
  <>
    <path d="M4 8h3l2-3h6l2 3h3v11H4V8z" />
    <circle cx="12" cy="13" r="3.5" />
  </>,
);
export const IconPhone = icon(<path d="M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z" />);
export const IconMessage = icon(<path d="M4 5h16v11H9l-5 4V5z" />);
export const IconMegaphone = icon(<path d="M3 10v4h3l8 5V5l-8 5H3zM18 9a4 4 0 010 6" />);
export const IconScreen = icon(
  <>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16v4" />
  </>,
);
export const IconVolume = icon(<path d="M4 10v4h3l5 4V6l-5 4H4zM16 9a4 4 0 010 6M18.5 6.5a8 8 0 010 11" />);
export const IconVolumeOff = icon(<path d="M4 10v4h3l5 4V6l-5 4H4zM16 9.5l5 5M21 9.5l-5 5" />);
export const IconBook = icon(<path d="M5 4h12a2 2 0 012 2v14H7a2 2 0 01-2-2V4zM5 17a2 2 0 012-2h12M9 8h6" />);
export const IconKey = icon(
  <>
    <circle cx="8" cy="15" r="4" />
    <path d="M11 12l9-9M16 7l3 3M14 9l2 2" />
  </>,
);
export const IconExpand = icon(<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />);
export const IconList = icon(<path d="M8 6h12M8 12h12M8 18h12M4 6v.01M4 12v.01M4 18v.01" />);
