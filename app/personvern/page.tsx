import type { Metadata } from "next";
import Link from "next/link";

import { LEGAL } from "@/lib/legal";
import { no } from "@/lib/locale/no";

export const metadata: Metadata = { title: "Personvern — Chase" };
const l = no.legal;

export default function Page() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <Link href="/" className="text-sm text-txt-dim">
        {l.back}
      </Link>
      <h1 className="mt-6 text-4xl font-black">{l.title}</h1>
      <p className="mt-3 text-txt-dim">{l.lead}</p>
      <ul className="mt-6 space-y-3">
        {LEGAL.map((d) => (
          <li key={d.slug}>
            <Link href={`/personvern/${d.slug}`} className="block rounded-2xl border border-line bg-ink-2 p-4 font-extrabold hover:bg-ink-3">
              {d.slug === "dpia" ? l.dpia : l.dpa}
              <span className="mt-1 block text-sm font-normal text-txt-dim">{d.lead}</span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
