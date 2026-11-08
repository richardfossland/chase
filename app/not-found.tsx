import Link from "next/link";

import { no } from "@/lib/locale/no";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-4 text-center">
      <p className="text-3xl font-black text-gold">{no.brand}</p>
      <h1 className="mt-6 text-2xl font-extrabold">{no.common.notFoundTitle}</h1>
      <p className="mt-2 text-txt-dim">{no.common.notFoundBody}</p>
      <Link href="/" className="mt-6 grid min-h-12 place-items-center rounded-xl bg-gold px-5 font-extrabold text-ink">
        {no.common.home}
      </Link>
    </main>
  );
}
