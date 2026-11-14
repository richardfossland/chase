import Link from "next/link";

import { no } from "@/lib/locale/no";

// Server component: lib/client/ui is a client module, so the button look is spelled out here.
export default function NotFound() {
  return (
    <main className="m-rise-in mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-4 text-center">
      <LostDot />
      <p className="mt-6 text-sm font-bold tracking-[0.18em] text-gold-text uppercase">{no.brand}</p>
      <h1 className="mt-2 text-3xl font-black tracking-tight">{no.common.notFoundTitle}</h1>
      <p className="mt-2 leading-relaxed text-txt-dim">{no.common.notFoundBody}</p>
      <Link
        href="/"
        className="ui-press mt-8 inline-flex min-h-12 items-center justify-center rounded-[var(--radius-ctl)] bg-gold px-6 font-extrabold text-on-accent shadow-[var(--shadow-card)] hover:bg-gold-light"
      >
        {no.common.home}
      </Link>
    </main>
  );
}

/** A dashed play area with the runner outside it. */
function LostDot() {
  return (
    <svg width="132" height="96" viewBox="0 0 132 96" aria-hidden>
      <path d="M14 30 L60 10 L104 28 L96 78 L30 84 Z" fill="#ebb84b" fillOpacity="0.14" stroke="#d4a23a" strokeWidth="2.5" strokeDasharray="6 5" strokeLinejoin="round" />
      <circle cx="58" cy="50" r="6" fill="#4fd18b" stroke="#fff" strokeWidth="2.5" />
      <circle cx="120" cy="14" r="7" fill="#3d9bff" stroke="#fff" strokeWidth="2.5" className="t-ping" />
      <circle cx="120" cy="14" r="7" fill="#3d9bff" stroke="#fff" strokeWidth="2.5" />
    </svg>
  );
}
