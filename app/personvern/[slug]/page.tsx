import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { LEGAL, legalDoc } from "@/lib/legal";
import { no } from "@/lib/locale/no";

import PrintButton from "../PrintButton";

const l = no.legal;

export function generateStaticParams() {
  return LEGAL.map((d) => ({ slug: d.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const d = legalDoc((await params).slug);
  return { title: d ? `${d.title} — Chase` : "Chase" };
}

/** A template (PLAN §8), printable as A4 / «lagre som PDF». */
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const d = legalDoc((await params).slug);
  if (!d) notFound();
  return (
    <main className="min-h-dvh bg-white px-4 py-8 text-[#14171e] print:p-0">
      <article className="mx-auto max-w-3xl">
        <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
          <Link href="/personvern" className="font-bold underline">
            {l.back}
          </Link>
          <PrintButton label={l.print} />
        </div>
        <p className="mt-6 rounded-lg border-2 border-dashed border-[#b45309] px-3 py-2 text-sm font-bold text-[#b45309]">{l.draft}</p>
        <h1 className="mt-4 text-3xl font-black">{d.title}</h1>
        <p className="mt-3 text-lg">{d.lead}</p>
        {d.sections.map((s) => (
          <section key={s.h} className="mt-6 break-inside-avoid">
            <h2 className="text-xl font-black">{s.h}</h2>
            {s.p?.map((x) => (
              <p key={x} className="mt-2 leading-relaxed">
                {x}
              </p>
            ))}
            {s.list && (
              <ul className="mt-2 list-disc space-y-1 pl-6 leading-relaxed">
                {s.list.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </article>
    </main>
  );
}
