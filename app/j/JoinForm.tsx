"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { ApiError, api } from "@/lib/client/api";
import { identity } from "@/lib/client/identity";
import { normalizeResumeCode } from "@/lib/codes";
import { looksLikeFullName } from "@/lib/nickname";
import { no } from "@/lib/locale/no";

const t = no.join;

function errorText(e: unknown) {
  const code = e instanceof ApiError ? e.code : "default";
  return (t.errors as Record<string, string>)[code] ?? t.errors.default;
}

/**
 * PLAN §2.2 step 1: QR → /j/123456 → nickname → play. A stored identity for
 * the same PIN skips straight back into the game. Resume code on a new device.
 */
export default function JoinForm({ initialPin }: { initialPin?: string }) {
  const router = useRouter();
  const [pin, setPin] = useState(initialPin ?? "");
  const [nick, setNick] = useState("");
  const [code, setCode] = useState("");
  const [mode, setMode] = useState<"join" | "resume">("join");
  const [warnName, setWarnName] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newCode, setNewCode] = useState<{ code: string; sessionId: string } | null>(null);

  // Same device, same PIN: go straight back in.
  useEffect(() => {
    const me = identity.player();
    if (me && initialPin && me.pin === initialPin) router.replace(`/play/${me.sessionId}`);
  }, [initialPin, router]);

  async function join(force = false) {
    if (busy) return;
    if (!force && looksLikeFullName(nick)) return setWarnName(true);
    setBusy(true);
    setError(null);
    try {
      const r = await api.join(pin.trim(), nick.trim(), identity.deviceId());
      identity.savePlayer({
        sessionId: r.sessionId,
        playerId: r.playerId,
        token: r.token,
        resumeCode: r.resumeCode,
        nickname: r.nickname,
        pin: pin.trim(),
      });
      setNewCode({ code: r.resumeCode, sessionId: r.sessionId });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      setWarnName(false);
    }
  }

  async function resume() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const c = normalizeResumeCode(code);
      const r = await api.resume(pin.trim(), c);
      identity.savePlayer({
        sessionId: r.sessionId,
        playerId: r.playerId,
        token: r.token,
        resumeCode: c,
        nickname: r.nickname,
        pin: pin.trim(),
      });
      router.replace(`/play/${r.sessionId}`);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  const input = "mt-1 w-full rounded-xl border border-line bg-ink px-4 py-3 text-xl font-bold outline-none focus:border-gold";
  const primary =
    "mt-5 w-full rounded-2xl bg-gold px-6 py-4 text-xl font-black text-on-accent transition active:scale-[0.98] disabled:opacity-40";

  if (newCode) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-5 py-10">
        <h1 className="text-3xl font-black">{t.codeTitle}</h1>
        <p className="mt-6 rounded-2xl border border-gold/40 bg-ink-2 py-6 text-center font-mono text-5xl font-black tracking-widest text-gold" data-testid="resume-code">
          {newCode.code}
        </p>
        <p className="mt-4 text-txt-dim">{t.codeBody}</p>
        <button className={primary} onClick={() => router.replace(`/play/${newCode.sessionId}`)}>
          {t.codeOk}
        </button>
      </main>
    );
  }

  const pinOk = /^\d{6}$/.test(pin.trim());

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-5 py-10">
      <h1 className="text-4xl font-black">
        <span className="text-gold">{no.brand}</span> · {t.title}
      </h1>

      <form
        className="mt-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (mode === "join") void join();
          else void resume();
        }}
      >
        <label className="block">
          <span className="text-sm font-semibold text-txt-dim">{t.pinLabel}</span>
          <input
            className={`${input} font-mono tracking-[0.3em]`}
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
            placeholder="123456"
          />
        </label>

        {mode === "join" ? (
          <>
            <label className="mt-4 block">
              <span className="text-sm font-semibold text-txt-dim">{t.nickLabel}</span>
              <input
                className={input}
                autoComplete="off"
                autoCapitalize="words"
                maxLength={20}
                value={nick}
                onChange={(e) => {
                  setNick(e.target.value);
                  setWarnName(false);
                }}
                placeholder="Lynet"
              />
              <span className="mt-1 block text-xs text-txt-dim">{t.nickHint}</span>
            </label>
            {warnName && (
              <div className="mt-3 rounded-xl border border-warn/50 bg-warn/10 p-3">
                <p className="text-sm font-semibold text-warn">{t.fullNameWarn}</p>
                <button type="button" className="mt-2 text-sm font-bold underline" onClick={() => void join(true)}>
                  {t.useAnyway}
                </button>
              </div>
            )}
            {error && <p className="mt-3 font-semibold text-danger">{error}</p>}
            <button className={primary} disabled={!pinOk || !nick.trim() || busy}>
              {busy ? t.joining : t.join}
            </button>
            <button type="button" className="mt-4 w-full text-sm text-txt-dim underline" onClick={() => setMode("resume")}>
              {t.haveCode}
            </button>
          </>
        ) : (
          <>
            <label className="mt-4 block">
              <span className="text-sm font-semibold text-txt-dim">{t.codeLabel}</span>
              <input
                className={`${input} font-mono uppercase tracking-widest`}
                autoComplete="off"
                autoCapitalize="characters"
                maxLength={8}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="KOLE-7F"
              />
            </label>
            {error && <p className="mt-3 font-semibold text-danger">{error}</p>}
            <button className={primary} disabled={!pinOk || code.replace(/[^A-Za-z0-9]/g, "").length !== 6 || busy}>
              {t.resume}
            </button>
            <button type="button" className="mt-4 w-full text-sm text-txt-dim underline" onClick={() => setMode("join")}>
              {t.backToJoin}
            </button>
          </>
        )}
      </form>
    </main>
  );
}
