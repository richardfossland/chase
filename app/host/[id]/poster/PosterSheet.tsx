"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { api } from "@/lib/client/api";
import { identity } from "@/lib/client/identity";
import { QRCode } from "@/lib/client/QRCode";
import { no } from "@/lib/locale/no";
import { qrUrl } from "@/lib/qr";

const p = no.host.poster;

type Card = { n: number; code: string; value: number };

/** Printable physical QR posts (PLAN §1 «Fysiske QR-poster»): 6 per A4 page. */
export default function PosterSheet({ sessionId }: { sessionId: string }) {
  const [cards, setCards] = useState<Card[] | null>(null);
  const [error, setError] = useState(false);
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- window is client-only
    setOrigin(window.location.origin);
    const token = identity.hostToken(sessionId);
    if (!token) {
      setError(true);
      return;
    }
    api
      .snapshot(sessionId, token, true)
      .then((s) => setCards(s.qr_cards ?? []))
      .catch(() => setError(true));
  }, [sessionId]);

  return (
    <main className="min-h-dvh bg-white px-4 py-6 text-[#14171e] print:p-0">
      <div className="mx-auto max-w-4xl print:hidden">
        <h1 className="text-3xl font-black">{p.title}</h1>
        <p className="mt-2 max-w-2xl">{p.lead}</p>
        <div className="mt-4 flex gap-3">
          <button className="rounded-xl bg-[#14171e] px-5 py-3 font-extrabold text-white" onClick={() => window.print()} disabled={!cards?.length}>
            🖨 {p.print}
          </button>
          <Link href={`/host/${sessionId}`} className="rounded-xl border border-[#14171e] px-5 py-3 font-bold">
            {p.back}
          </Link>
        </div>
        {error && <p className="mt-4 font-bold text-red-700">{no.host.noToken}</p>}
        {cards && !cards.length && <p className="mt-4 font-bold">{p.none}</p>}
      </div>

      {cards && origin && (
        <section className="mx-auto mt-6 grid max-w-4xl grid-cols-2 gap-4 print:mt-0 print:gap-0">
          {cards.map((c) => (
            <article
              key={c.code}
              className="flex break-inside-avoid flex-col items-center justify-center rounded-2xl border-4 border-dashed border-[#14171e] p-4 text-center print:h-[33vh] print:rounded-none print:border-2"
            >
              <p className="text-4xl font-black">{p.card(c.n)}</p>
              <QRCode value={qrUrl(origin, sessionId, c.code)} size={200} />
              <p className="mt-1 text-sm font-bold uppercase tracking-widest">{p.code}</p>
              <p className="font-mono text-3xl font-black tracking-[0.3em]">{c.code}</p>
              <p className="mt-1 text-sm font-bold">Chase · {p.points(c.value)}</p>
            </article>
          ))}
        </section>
      )}
    </main>
  );
}
