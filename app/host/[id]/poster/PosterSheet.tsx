"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { api } from "@/lib/client/api";
import { identity } from "@/lib/client/identity";
import { QRCode } from "@/lib/client/QRCode";
import { no } from "@/lib/locale/no";
import { qrUrl } from "@/lib/qr";
import { buttonClass } from "@/lib/client/ui";

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
    <main className="min-h-dvh bg-ink px-4 py-8 text-txt print:bg-white print:p-0 print:text-[#14171e]">
      <div className="m-rise-in mx-auto max-w-4xl rounded-[var(--radius-card)] bg-ink-2 p-6 shadow-[var(--shadow-card)] print:hidden">
        <h1 className="text-3xl font-black tracking-tight">{p.title}</h1>
        <p className="mt-2 max-w-2xl text-txt-dim">{p.lead}</p>
        <div className="mt-5 flex flex-wrap gap-3">
          <button className={buttonClass("primary", "md")} onClick={() => window.print()} disabled={!cards?.length}>
            🖨 {p.print}
          </button>
          <Link href={`/host/${sessionId}`} className={buttonClass("secondary", "md")}>
            {p.back}
          </Link>
        </div>
        {error && <p className="mt-4 font-bold text-danger-text">{no.host.noToken}</p>}
        {cards && !cards.length && <p className="mt-4 font-bold">{p.none}</p>}
      </div>

      {cards && origin && (
        <section className="m-fade-in mx-auto mt-6 grid max-w-4xl grid-cols-2 gap-4 print:mt-0 print:gap-0 print:[animation:none]">
          {cards.map((c) => (
            <article
              key={c.code}
              className="flex break-inside-avoid flex-col items-center justify-center rounded-2xl border-4 border-dashed border-[#14171e] bg-white p-4 text-center text-[#14171e] print:h-[33vh] print:rounded-none print:border-2"
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
