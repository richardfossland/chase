"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { api, type LibArea } from "@/lib/client/api";
import { identity } from "@/lib/client/identity";
import { QRCode } from "@/lib/client/QRCode";
import { buttonClass } from "@/lib/client/ui";
import { IconArrowLeft, IconPrinter } from "@/lib/client/ui/icons";
import { no } from "@/lib/locale/no";
import { qrAreaUrl } from "@/lib/qr";

const p = no.library.print;

type State = { kind: "loading" } | { kind: "error"; text: string } | { kind: "ok"; area: LibArea };

/** Printable A4 QR cards (0016): one per fixed QR post of an area, 4 per page. */
export default function PrintSheet({ areaId }: { areaId: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- window/localStorage are client-only
    setOrigin(window.location.origin);
    const key = identity.teacherKey();
    if (!key) {
      setState({ kind: "error", text: p.noKey });
      return;
    }
    api.library
      .get(key)
      .then((l) => {
        const a = l.areas.find((x) => x.id === areaId);
        setState(a ? { kind: "ok", area: a } : { kind: "error", text: p.notFound });
      })
      .catch(() => setState({ kind: "error", text: p.notFound }));
  }, [areaId]);

  // Card number = the post's place in the list (the number the pupils see).
  const cards =
    state.kind === "ok"
      ? (state.area.posts ?? []).map((post, i) => ({ post, n: i + 1 })).filter((c) => c.post.qr && c.post.code)
      : [];

  return (
    <main className="min-h-dvh bg-ink px-4 py-8 text-txt print:bg-white print:p-0 print:text-[#14171e]">
      <div className="m-rise-in mx-auto max-w-4xl rounded-[var(--radius-card)] bg-ink-2 p-6 shadow-[var(--shadow-card)] sm:p-8 print:hidden">
        <Link href="/bibliotek" className={buttonClass("ghost", "md", "-ml-3 min-h-12")}>
          <IconArrowLeft size={18} />
          {p.back}
        </Link>
        <h1 className="mt-4 text-3xl font-black tracking-tight">{p.title}</h1>
        {state.kind === "ok" && <p className="mt-1 font-bold text-txt-dim">{state.area.name}</p>}
        <p className="mt-2 text-txt-dim">{p.lead}</p>
        <p className="mt-2 text-sm text-txt-dim">{p.info}</p>
        <div className="mt-6">
          <button className={buttonClass("primary", "lg")} onClick={() => window.print()} disabled={!cards.length}>
            <IconPrinter size={20} />
            {p.print}
          </button>
        </div>
        {state.kind === "loading" && <p className="mt-4 text-txt-dim">{p.loading}</p>}
        {state.kind === "error" && <p className="mt-4 font-bold text-danger-text">{state.text}</p>}
        {state.kind === "ok" && !cards.length && <p className="mt-4 font-bold">{p.none}</p>}
      </div>

      {origin && cards.length > 0 && (
        <section className="m-fade-in mx-auto mt-6 grid max-w-4xl grid-cols-2 gap-4 print:mt-0 print:block print:max-w-none print:[animation:none]" data-testid="print-cards">
          {cards.map(({ post, n }) => (
            <article
              key={post.code}
              className="flex break-inside-avoid flex-col items-center justify-center rounded-2xl border-4 border-dashed border-[#14171e] bg-white p-4 text-center text-[#14171e] print:float-left print:box-border print:h-[calc(50vh-1px)] print:w-1/2 print:rounded-none print:border-2"
            >
              <p className="text-5xl font-black">{p.card(n)}</p>
              {post.name && <p className="mt-1 text-xl font-bold">{post.name}</p>}
              {post.kind === "golden" && <p className="text-sm font-black uppercase tracking-widest">{p.golden}</p>}
              <div className="mt-2">
                <QRCode value={qrAreaUrl(origin, post.code!)} size={260} />
              </div>
              <p className="mt-1 text-sm font-bold uppercase tracking-widest">{p.code}</p>
              <p className="font-mono text-3xl font-black tracking-[0.3em]">{post.code}</p>
              <p className="mt-1 text-sm font-semibold">{p.how}</p>
              <p className="text-xs">{p.how2}</p>
              <p className="mt-1 text-xs font-bold">Chase</p>
            </article>
          ))}
        </section>
      )}
    </main>
  );
}
