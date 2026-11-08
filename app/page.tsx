import Link from "next/link";

import { no } from "@/lib/locale/no";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center px-4 py-12 sm:px-6">
      <p className="inline-flex w-fit items-center gap-2 rounded-full border border-line bg-ink-2 px-3 py-1 text-xs font-bold uppercase tracking-widest text-gold">
        <span className="size-2 animate-pulse rounded-full bg-gold" aria-hidden />
        {no.landing.comingSoon}
      </p>

      <h1 className="mt-6 text-6xl font-black tracking-tight sm:text-7xl">
        <span className="bg-gradient-to-br from-gold-light via-gold to-gold-deep bg-clip-text text-transparent">
          {no.brand}
        </span>
      </h1>
      <p className="mt-2 text-xl font-bold text-txt">{no.tagline}</p>
      <p className="mt-4 max-w-prose text-lg text-txt-dim">{no.landing.lead}</p>

      <ul className="mt-10 grid gap-3 sm:grid-cols-3">
        {no.landing.pillars.map((p, i) => (
          <li key={p.title} className="rounded-2xl border border-line bg-ink-2 p-4">
            <span
              className={`block h-1.5 w-10 rounded-full ${["bg-hunter", "bg-prey", "bg-ok"][i]}`}
              aria-hidden
            />
            <h2 className="mt-3 font-extrabold">{p.title}</h2>
            <p className="mt-1 text-sm text-txt-dim">{p.body}</p>
          </li>
        ))}
      </ul>

      <div className="mt-10 flex flex-wrap items-center gap-4">
        <Link
          href="/ny"
          className="rounded-xl bg-gold px-6 py-3 text-lg font-extrabold text-ink transition hover:bg-gold-light active:scale-[0.98]"
        >
          {no.landing.startSession}
        </Link>
        <Link
          href="/j"
          className="rounded-xl border border-line px-6 py-3 text-lg font-extrabold text-txt transition hover:bg-ink-3 active:scale-[0.98]"
        >
          {no.landing.join}
        </Link>
        <p className="text-sm text-txt-dim">{no.landing.phaseNote}</p>
      </div>

      <footer className="mt-16 text-xs text-txt-dim">Chase · en del av Sunday Suite</footer>
    </main>
  );
}
