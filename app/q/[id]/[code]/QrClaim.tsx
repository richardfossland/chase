"use client";

import Link from "next/link";
import { useEffect, useState, type CSSProperties } from "react";

import { ApiError, api, type QrResult } from "@/lib/client/api";
import { identity } from "@/lib/client/identity";
import { no } from "@/lib/locale/no";
import { parseQr } from "@/lib/qr";
import { buttonClass, cx } from "@/lib/client/ui";

const t = no.play;
const q = no.qr.page;

type State = { kind: "working" } | { kind: "noPlayer" } | { kind: "ok"; r: QrResult } | { kind: "error"; text: string };

export default function QrClaim({ sessionId, code }: { sessionId: string; code: string }) {
  const [state, setState] = useState<State>({ kind: "working" });

  useEffect(() => {
    const me = identity.player();
    const c = parseQr(code, sessionId);
    if (!me || me.sessionId !== sessionId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is client-only
      setState({ kind: "noPlayer" });
      return;
    }
    if (!c) {
      setState({ kind: "error", text: t.qrBad });
      return;
    }
    api
      .qr(sessionId, { playerId: me.playerId, token: me.token, code: c })
      .then((r) => setState({ kind: "ok", r }))
      .catch((e) => {
        const err = e instanceof ApiError ? e.code : "";
        setState({ kind: "error", text: err === "bad_code" ? t.qrBad : err === "not_now" ? t.qrNotNow : t.qrError });
      });
  }, [code, sessionId]);

  const ok = state.kind === "ok" && !state.r.already;
  return (
    <main
      className={cx(
        "theme-dark m-tone relative flex min-h-dvh flex-col items-center justify-center overflow-hidden px-6 pt-[max(2rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))] text-center",
        ok ? "bg-ok text-on-accent" : "bg-ink text-txt",
      )}
    >
      {ok && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center" aria-hidden>
          <span className="p-ripple col-start-1 row-start-1 block size-[70vmin] rounded-full border-[10px] border-white/70" />
          <span className="p-ripple-2 col-start-1 row-start-1 block size-[70vmin] rounded-full border-[6px] border-white/50" />
        </div>
      )}
      <div className="relative flex w-full max-w-md flex-col items-center">
        <p className="m-fade-in text-sm font-black uppercase tracking-[0.25em] opacity-70">{q.title}</p>
        {state.kind === "working" && (
          <div className="mt-8 flex gap-2" role="status" aria-label="…">
            {[0, 1, 2].map((i) => (
              <span key={i} className="size-4 animate-pulse rounded-full bg-gold" style={{ animationDelay: `${i * 160}ms` }} />
            ))}
          </div>
        )}
        {state.kind === "noPlayer" && <p className="m-rise-in mt-6 text-2xl font-black leading-tight">{q.noPlayer}</p>}
        {state.kind === "error" && (
          <p className="m-shake mt-6 rounded-[var(--radius-card)] bg-danger/15 px-5 py-4 text-2xl font-black text-danger-text">{state.text}</p>
        )}
        {state.kind === "ok" && (
          <div className="m-stagger mt-4 flex flex-col items-center">
            <p className="text-2xl font-black" style={{ "--i": 0 } as CSSProperties}>
              {t.qrPost(state.r.n)}
            </p>
            <div style={{ "--i": 1 } as CSSProperties}>
              <p className="m-pop mt-2 text-7xl font-black leading-none">{state.r.already ? "✔" : t.qrOk(state.r.value, state.r.first)}</p>
            </div>
            {state.r.already && (
              <p className="mt-4 text-lg font-bold text-txt-dim" style={{ "--i": 2 } as CSSProperties}>
                {t.qrAlready}
              </p>
            )}
          </div>
        )}
        <Link
          href={state.kind === "noPlayer" ? "/j" : `/play/${sessionId}`}
          className={buttonClass(ok ? "secondary" : "primary", "xl", "m-rise-in mt-10 w-full")}
        >
          {state.kind === "noPlayer" ? t.toJoin : q.toGame}
        </Link>
      </div>
    </main>
  );
}
