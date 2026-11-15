// Wizard-only icons, same grid and stroke as lib/client/ui/icons.tsx.

import { icon } from "@/lib/client/ui/icons";

export const IconMinus = icon(<path d="M5 12h14" />);
/** Smittejakt: one dot spreading to others. */
export const IconSpread = icon(
  <>
    <circle cx="12" cy="12" r="3" />
    <circle cx="5" cy="6" r="1.6" />
    <circle cx="19" cy="6" r="1.6" />
    <circle cx="5" cy="18" r="1.6" />
    <circle cx="19" cy="18" r="1.6" />
    <path d="M9.7 9.9L6.3 7.1M14.3 9.9l3.4-2.8M9.7 14.1l-3.4 2.8M14.3 14.1l3.4 2.8" />
  </>,
);
/** Stafett: baton handed over. */
export const IconRelay = icon(<path d="M4 17l9-9M11 6l2-2 7 7-2 2M7 20l-3-3M14 13l3 3" />);
/** Revejakt: fox head. */
export const IconFox = icon(<path d="M4 4l4 5h8l4-5v8a8 8 0 01-16 0V4zM9.5 13v.5M14.5 13v.5M11 17h2" />);

/** Static SVG markup for the draggable assembly-point marker (created outside React). */
export const FLAG_SVG =
  '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 21V4M5 4h12l-2 4 2 4H5"/></svg>';
