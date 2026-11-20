"use client";

// Client: uses buttonClass() from lib/client/ui (a client module).
import Link from "next/link";

import { IconBook, IconMapPin, IconPlay, IconQr, IconRadar, IconUsers } from "@/lib/client/ui/icons";
import { buttonClass } from "@/lib/client/ui";
import { no } from "@/lib/locale/no";

const l = no.landing;
const STEP_ICONS = [IconMapPin, IconQr, IconRadar];

export default function Home() {
  return (
    <main className="relative min-h-dvh overflow-hidden">
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-[34rem] bg-[radial-gradient(60%_60%_at_70%_20%,rgb(235_184_75/0.18),transparent_70%)]"
        aria-hidden
      />

      <div className="relative mx-auto max-w-5xl px-5 pt-[max(1rem,env(safe-area-inset-top))] pb-12 sm:px-8">
        <header className="flex min-h-12 items-center">
          <span className="flex items-center gap-2 text-lg font-black tracking-tight">
            <span className="grid size-8 place-items-center rounded-full bg-gold text-sm text-on-accent" aria-hidden>
              C
            </span>
            {no.brand}
          </span>
        </header>

        <section className="mt-6 grid items-center gap-10 lg:mt-16 lg:grid-cols-[1.05fr_1fr] lg:gap-16">
          <div className="m-stagger order-2 lg:order-1">
            <h1 className="text-5xl font-black tracking-tight sm:text-6xl lg:text-7xl" style={{ "--i": 0 } as React.CSSProperties}>
              {no.brand}
              <span className="text-gold">.</span>
            </h1>
            <p className="mt-3 max-w-prose text-xl leading-snug text-txt-dim sm:text-2xl" style={{ "--i": 1 } as React.CSSProperties}>
              {l.lead}
            </p>

            <div className="mt-9 grid gap-4 sm:grid-cols-2" style={{ "--i": 2 } as React.CSSProperties}>
              <Link href="/ny" className={buttonClass("primary", "lg", "min-h-24 flex-col gap-1 py-5")} data-testid="landing-start">
                <span className="flex items-center gap-2">
                  <IconPlay size={22} />
                  {l.startSession}
                </span>
                <span className="text-sm font-semibold opacity-75">{l.startHint}</span>
              </Link>
              <Link href="/j" className={buttonClass("secondary", "lg", "min-h-24 flex-col gap-1 py-5 shadow-[var(--shadow-card)]")} data-testid="landing-join">
                <span className="flex items-center gap-2">
                  <IconUsers size={22} />
                  {l.join}
                </span>
                <span className="text-sm font-semibold text-txt-dim">{l.joinHint}</span>
              </Link>
            </div>

          </div>

          <div className="m-fade-in order-1 lg:order-2">
            <HeroMap />
          </div>
        </section>

        <section className="mt-16 lg:mt-24">
          <h2 className="sr-only">{l.stepsTitle}</h2>
          <ol className="m-stagger grid gap-3 sm:grid-cols-3">
            {l.steps.map((st, i) => {
              const Icon = STEP_ICONS[i];
              return (
                <li key={st.title} className="flex items-center gap-4 rounded-[var(--radius-card)] bg-ink-2 p-5 shadow-[var(--shadow-card)]" style={{ "--i": i + 4 } as React.CSSProperties}>
                  <span className="grid size-12 shrink-0 place-items-center rounded-full bg-gold/15 text-gold-text">
                    <Icon size={22} />
                  </span>
                  <span className="min-w-0">
                    <span className="block font-extrabold">{st.title}</span>
                    <span className="block text-sm text-txt-dim">{st.body}</span>
                  </span>
                </li>
              );
            })}
          </ol>
        </section>

        <footer className="mt-16 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-txt-dim">
          <span>{l.footer}</span>
          <nav className="flex flex-wrap items-center gap-x-4" aria-label={l.links}>
            <Link href="/bibliotek" className="inline-flex min-h-12 items-center gap-1.5 underline underline-offset-4 hover:text-txt" data-testid="landing-library">
              <IconBook size={16} />
              {l.library}
            </Link>
            <Link href="/personvern" className="inline-flex min-h-12 items-center underline underline-offset-4 hover:text-txt">
              {no.legal.title}
            </Link>
          </nav>
        </footer>
      </div>
    </main>
  );
}

/** Decorative map: contour lines, the gold play-area boundary, a forbidden
 * zone, the assembly point and a few role-coloured dots slowly running. */
function HeroMap() {
  return (
    <div className="relative overflow-hidden rounded-[1.75rem] bg-ink-2 shadow-[var(--shadow-float)]">
      <svg viewBox="0 0 400 260" className="block h-auto w-full max-lg:max-h-[30dvh]" role="img" aria-hidden preserveAspectRatio="xMidYMid slice">
        <defs>
          <pattern id="hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="7" stroke="#ff3b30" strokeOpacity="0.45" strokeWidth="2.5" />
          </pattern>
        </defs>
        <rect width="400" height="260" fill="#fbf9f4" />
        {/* contour lines */}
        <g fill="none" stroke="#14171e" strokeOpacity="0.07" strokeWidth="1.5">
          <path d="M-10 60 C 80 30, 160 90, 250 55 S 390 40, 420 70" />
          <path d="M-10 110 C 70 80, 170 140, 260 105 S 380 95, 420 120" />
          <path d="M-10 165 C 90 140, 150 200, 250 160 S 370 150, 420 180" />
          <path d="M-10 220 C 80 200, 180 250, 270 215 S 380 210, 420 235" />
          <path d="M300 20 C 330 40, 360 30, 380 60 S 350 110, 320 90 S 280 40, 300 20 Z" />
        </g>
        {/* a path through the park */}
        <path d="M-10 200 C 90 190, 120 120, 210 130 S 330 210, 420 150" fill="none" stroke="#14171e" strokeOpacity="0.1" strokeWidth="9" strokeLinecap="round" />
        {/* play area */}
        <path
          className="t-draw"
          d="M70 70 L 250 38 L 340 120 L 300 222 L 110 228 L 48 150 Z"
          fill="#ebb84b"
          fillOpacity="0.12"
          stroke="#d4a23a"
          strokeWidth="3"
          strokeLinejoin="round"
        />
        {/* forbidden zone */}
        <path d="M262 150 L 312 140 L 318 190 L 270 198 Z" fill="url(#hatch)" stroke="#ff3b30" strokeOpacity="0.7" strokeWidth="2" />
        {/* assembly point */}
        <circle cx="128" cy="168" r="10" fill="#4fd18b" className="t-ping" />
        <circle cx="128" cy="168" r="8" fill="#4fd18b" stroke="#fff" strokeWidth="3" />
        {/* runners: prey slightly ahead of the hunter on the same loop */}
        <g className="t-run-a" style={{ animationDelay: "-1.6s" }}>
          <circle cx="120" cy="100" r="7" fill="#3d9bff" stroke="#fff" strokeWidth="2.5" />
        </g>
        <g className="t-run-a">
          <circle cx="120" cy="100" r="7" fill="#ff5a4e" stroke="#fff" strokeWidth="2.5" />
        </g>
        <g className="t-run-b">
          <circle cx="250" cy="90" r="7" fill="#3d9bff" stroke="#fff" strokeWidth="2.5" />
        </g>
        <g className="t-run-c" style={{ animationDelay: "-4s" }}>
          <circle cx="190" cy="150" r="7" fill="#3d9bff" stroke="#fff" strokeWidth="2.5" />
        </g>
        <g className="t-run-b" style={{ animationDelay: "-7s" }}>
          <circle cx="215" cy="130" r="7" fill="#ff5a4e" stroke="#fff" strokeWidth="2.5" />
        </g>
      </svg>
    </div>
  );
}
