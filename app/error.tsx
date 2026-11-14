"use client";

import Link from "next/link";

import { Button, buttonClass } from "@/lib/client/ui";
import { no } from "@/lib/locale/no";

export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="m-rise-in mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-4 text-center">
      <span className="grid size-16 place-items-center rounded-full bg-warn/15 text-3xl" aria-hidden>
        ⚠️
      </span>
      <p className="mt-6 text-sm font-bold tracking-[0.18em] text-gold-text uppercase">{no.brand}</p>
      <h1 className="mt-2 text-3xl font-black tracking-tight">{no.common.errorTitle}</h1>
      <p className="mt-2 leading-relaxed text-txt-dim">{no.common.errorBody}</p>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Button onClick={() => reset()}>{no.common.retry}</Button>
        <Link href="/" className={buttonClass("secondary", "md")}>
          {no.common.home}
        </Link>
      </div>
    </main>
  );
}
