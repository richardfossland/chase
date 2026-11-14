"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { ApiError, api, type QrResult } from "@/lib/client/api";
import { identity } from "@/lib/client/identity";
import { no } from "@/lib/locale/no";
import { parseQr } from "@/lib/qr";

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
    <main className={`flex min-h-dvh flex-col items-center justify-center gap-3 px-6 text-center ${ok ? "bg-ok text-on-accent" : "bg-ink text-txt"}`}>
      <p className="text-sm font-bold uppercase opacity-70">{q.title}</p>
      {state.kind === "working" && <p className="text-3xl font-black">…</p>}
      {state.kind === "noPlayer" && <p className="text-xl font-bold">{q.noPlayer}</p>}
      {state.kind === "error" && <p className="text-2xl font-black">{state.text}</p>}
      {state.kind === "ok" && (
        <>
          <p className="text-2xl font-black">{t.qrPost(state.r.n)}</p>
          <p className="text-7xl font-black">{state.r.already ? "✔" : t.qrOk(state.r.value, state.r.first)}</p>
          {state.r.already && <p className="text-lg font-bold">{t.qrAlready}</p>}
        </>
      )}
      <Link
        href={state.kind === "noPlayer" ? "/j" : `/play/${sessionId}`}
        className="mt-6 rounded-2xl bg-gold px-8 py-4 text-xl font-black text-on-accent"
      >
        {state.kind === "noPlayer" ? t.toJoin : q.toGame}
      </Link>
    </main>
  );
}
