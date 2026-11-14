"use client";

import Link from "next/link";
import { useState } from "react";

import { ApiError, api } from "@/lib/client/api";
import { identity } from "@/lib/client/identity";
import { no } from "@/lib/locale/no";

const s = no.share;

/** «Lag kopi» into my library (creates my lærernøkkel if this device has none), then start. */
export default function ShareActions({ code }: { code: string }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ planId: string; areaId: string | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="mt-6 space-y-3">
      {!done ? (
        <button
          className="w-full rounded-xl bg-gold px-5 py-4 text-lg font-extrabold text-on-accent transition hover:bg-gold-light disabled:opacity-50"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              const { key } = identity.ensureTeacherKey();
              setDone(await api.library.copy(key, code));
            } catch (e) {
              const c = e instanceof ApiError ? e.code : "default";
              setErr(no.library.errors[c] ?? no.library.errors.default);
            } finally {
              setBusy(false);
            }
          }}
          data-testid="share-copy"
        >
          {busy ? s.copying : s.copy}
        </button>
      ) : (
        <>
          <p className="rounded-xl bg-ok px-4 py-3 font-bold text-on-accent">{s.copied}</p>
          <Link
            href={`/ny?plan=${done.planId}${done.areaId ? `&area=${done.areaId}` : ""}`}
            className="block w-full rounded-xl bg-gold px-5 py-4 text-center text-lg font-extrabold text-on-accent"
            data-testid="share-start"
          >
            {s.start}
          </Link>
          <Link href="/bibliotek" className="block text-center text-txt-dim underline">
            {s.library}
          </Link>
        </>
      )}
      {err && <p className="font-bold text-danger">{err}</p>}
    </div>
  );
}
