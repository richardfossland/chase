"use client";

import Link from "next/link";
import { useState } from "react";

import { ApiError, api } from "@/lib/client/api";
import { identity } from "@/lib/client/identity";
import { buttonClass } from "@/lib/client/ui";
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
          className={buttonClass("primary", "lg", "w-full")}
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
          <p className="m-pop rounded-2xl bg-ok/15 px-4 py-3 font-bold text-ok-text" role="status">
            ✓ {s.copied}
          </p>
          <Link
            href={`/ny?plan=${done.planId}${done.areaId ? `&area=${done.areaId}` : ""}`}
            className={buttonClass("primary", "lg", "m-rise-in w-full")}
            data-testid="share-start"
          >
            {s.start}
          </Link>
          <Link href="/bibliotek" className={buttonClass("ghost", "md", "w-full text-txt-dim")}>
            {s.library}
          </Link>
        </>
      )}
      {err && (
        <p className="m-rise-in rounded-2xl bg-danger/10 px-4 py-3 font-bold text-danger-text" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}
