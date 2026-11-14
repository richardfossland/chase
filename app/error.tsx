"use client";

import Link from "next/link";

import { no } from "@/lib/locale/no";

export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-4 text-center">
      <p className="text-3xl font-black text-gold">{no.brand}</p>
      <h1 className="mt-6 text-2xl font-extrabold">{no.common.errorTitle}</h1>
      <p className="mt-2 text-txt-dim">{no.common.errorBody}</p>
      <div className="mt-6 flex gap-3">
        <button onClick={() => reset()} className="min-h-12 rounded-xl bg-gold px-5 font-extrabold text-on-accent">
          {no.common.retry}
        </button>
        <Link href="/" className="grid min-h-12 place-items-center rounded-xl border border-line px-5 font-bold">
          {no.common.home}
        </Link>
      </div>
    </main>
  );
}
