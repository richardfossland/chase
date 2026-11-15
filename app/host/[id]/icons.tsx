// Host-only line icons, same grid and stroke as lib/client/ui/icons.tsx.

import { icon } from "@/lib/client/ui/icons";

/** «Samle alle»: four arrows converging on a point. */
export const IconGather = icon(
  <>
    <circle cx="12" cy="12" r="2" />
    <path d="M3 3l5 5M8 4v4H4M21 3l-5 5M16 4v4h4M3 21l5-5M4 16h4v4M21 21l-5-5M20 16h-4v4" />
  </>,
);
/** «Sitter over». */
export const IconMinusCircle = icon(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M8 12h8" />
  </>,
);
export const IconChevronUp = icon(<path d="M6 15l6-6 6 6" />);
export const IconTimerPlus = icon(
  <>
    <circle cx="12" cy="13" r="8" />
    <path d="M12 9v4M10 3h4M9 13h6" />
  </>,
);
