import type { Metadata } from "next";
import Link from "next/link";

import { LEGAL } from "@/lib/legal";
import { no } from "@/lib/locale/no";

export const metadata: Metadata = { title: "Personvern — Chase" };
const l = no.legal;

export default function Page() {
  return (
    <main className="mx-auto max-w-2xl px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-16 sm:px-6">
      <Link href="/" className="-ml-3 inline-flex min-h-12 items-center rounded-[var(--radius-ctl)] px-3 text-sm font-bold text-txt-dim hover:bg-ink-3 hover:text-txt">
        {l.back}
      </Link>
      <div className="m-rise-in">
        <h1 className="mt-8 text-4xl font-black tracking-tight">{l.title}</h1>
        <p className="mt-3 max-w-prose leading-relaxed text-txt-dim">{l.lead}</p>
      </div>
      <ul className="m-stagger mt-8 space-y-3">
        {LEGAL.map((d, i) => (
          <li key={d.slug} style={{ "--i": i + 1 } as React.CSSProperties}>
            <Link
              href={`/personvern/${d.slug}`}
              className="ui-press group flex items-center gap-4 rounded-[var(--radius-card)] bg-ink-2 p-5 font-extrabold shadow-[var(--shadow-card)] hover:shadow-[var(--shadow-float)]"
            >
              <span className="min-w-0 flex-1">
                {d.slug === "dpia" ? l.dpia : l.dpa}
                <span className="mt-1 block text-sm leading-relaxed font-normal text-txt-dim">{d.lead}</span>
              </span>
              <span className="text-txt-dim transition-transform duration-[var(--dur-2)] group-hover:translate-x-1" aria-hidden>
                →
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
