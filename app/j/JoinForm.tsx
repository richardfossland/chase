"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { ApiError, api } from "@/lib/client/api";
import { identity } from "@/lib/client/identity";
import { normalizeResumeCode } from "@/lib/codes";
import { looksLikeFullName } from "@/lib/nickname";
import { no } from "@/lib/locale/no";
import { Button, cx } from "@/lib/client/ui";

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
  const [shake, setShake] = useState(0); // bumps on every error → m-shake
  const nickRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);

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
      setShake((k) => k + 1);
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
      setShake((k) => k + 1);
      setBusy(false);
    }
  }

  const input =
    "mt-2 block min-h-14 w-full rounded-[var(--radius-ctl)] border-2 border-line bg-ink-2 px-4 py-3 text-xl font-bold text-txt outline-none transition-colors duration-[var(--dur-2)] placeholder:text-txt-dim/50 focus:border-gold";
  const label = "text-sm font-extrabold uppercase tracking-wide text-txt-dim";

  if (newCode) {
    return (
      <main className="theme-dark mx-auto flex min-h-dvh max-w-md flex-col px-5 pt-[max(2.5rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))]">
        <div className="m-stagger flex flex-1 flex-col justify-center">
          <p className="text-sm font-black uppercase tracking-[0.25em] text-ok-text" style={{ "--i": 0 } as React.CSSProperties}>
            {t.codeKicker}
          </p>
          <h1 className="mt-2 text-5xl font-black tracking-tight" style={{ "--i": 1 } as React.CSSProperties}>
            {t.codeTitle}
          </h1>
          <div className="mt-8" style={{ "--i": 2 } as React.CSSProperties}>
            <p
              className="p-flip-in rounded-[var(--radius-card)] border-2 border-gold/60 bg-ink-2 px-4 py-9 text-center font-mono text-5xl font-black tracking-widest text-gold-text shadow-[var(--shadow-float)]"
              style={{ animationDelay: "140ms" }}
              data-testid="resume-code"
            >
              {newCode.code}
            </p>
          </div>
          <p className="mt-6 text-lg leading-snug text-txt-dim" style={{ "--i": 3 } as React.CSSProperties}>
            {t.codeBody}
          </p>
        </div>
        <Button size="xl" className="m-rise-in mt-8 w-full" onClick={() => router.replace(`/play/${newCode.sessionId}`)}>
          {t.codeOk}
        </Button>
      </main>
    );
  }

  const pinOk = /^\d{6}$/.test(pin.trim());

  return (
    <main className="theme-dark mx-auto flex min-h-dvh max-w-md flex-col px-5 pt-[max(2.5rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))]">
      <div className="m-stagger flex flex-1 flex-col justify-center">
        <p className="text-sm font-black uppercase tracking-[0.25em] text-gold-text" style={{ "--i": 0 } as React.CSSProperties}>
          {no.brand}
        </p>
        <h1 className="mt-2 text-5xl font-black tracking-tight" style={{ "--i": 1 } as React.CSSProperties}>
          {mode === "join" ? t.title : t.codeLabel}
        </h1>
        <p className="mt-3 text-lg text-txt-dim" style={{ "--i": 2 } as React.CSSProperties}>
          {mode === "join" ? t.lead : t.codeBody}
        </p>

        <form
          className="mt-9"
          style={{ "--i": 3 } as React.CSSProperties}
          onSubmit={(e) => {
            e.preventDefault();
            if (mode === "join") void join();
            else void resume();
          }}
        >
          <div key={shake} className={cx("space-y-6", shake > 0 && "m-shake")}>
            <div>
              <span className={label} id="pin-label">
                {t.pinLabel}
              </span>
              <PinBoxes
                value={pin}
                onChange={(v) => {
                  setPin(v);
                  setError(null);
                  if (v.length === 6) (mode === "join" ? nickRef : codeRef).current?.focus();
                }}
                error={!!error}
              />
            </div>

            {mode === "join" ? (
              <label className="block">
                <span className={label}>{t.nickLabel}</span>
                <input
                  ref={nickRef}
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
                <span className="mt-2 block text-sm text-txt-dim">{t.nickHint}</span>
              </label>
            ) : (
              <label className="block">
                <span className={label}>{t.codeLabel}</span>
                <input
                  ref={codeRef}
                  className={`${input} font-mono uppercase tracking-widest`}
                  autoComplete="off"
                  autoCapitalize="characters"
                  maxLength={8}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="KOLE-7F"
                />
              </label>
            )}
          </div>

          {mode === "join" && warnName && (
            <div className="m-rise-in mt-4 rounded-[var(--radius-ctl)] border border-warn/50 bg-warn/10 p-4">
              <p className="font-bold text-warn-text">{t.fullNameWarn}</p>
              <button type="button" className="ui-press mt-2 min-h-12 font-extrabold text-warn-text underline" onClick={() => void join(true)}>
                {t.useAnyway}
              </button>
            </div>
          )}
          {error && (
            <p className="m-rise-in mt-4 rounded-[var(--radius-ctl)] bg-danger/15 px-4 py-3 font-bold text-danger-text" role="alert">
              {error}
            </p>
          )}

          {mode === "join" ? (
            <>
              <Button type="submit" size="xl" className="mt-7 w-full" disabled={!pinOk || !nick.trim() || busy}>
                {busy ? t.joining : t.join}
              </Button>
              <Button variant="ghost" className="mt-3 w-full text-txt-dim" onClick={() => switchMode("resume")}>
                {t.haveCode}
              </Button>
            </>
          ) : (
            <>
              <Button type="submit" size="xl" className="mt-7 w-full" disabled={!pinOk || code.replace(/[^A-Za-z0-9]/g, "").length !== 6 || busy}>
                {t.resume}
              </Button>
              <Button variant="ghost" className="mt-3 w-full text-txt-dim" onClick={() => switchMode("join")}>
                {t.backToJoin}
              </Button>
            </>
          )}
        </form>
      </div>
    </main>
  );

  function switchMode(m: "join" | "resume") {
    setMode(m);
    setError(null);
    setShake(0);
  }
}

/** Six PIN boxes over one real input: keeps inputMode="numeric", paste and autofill. */
function PinBoxes({ value, onChange, error }: { value: string; onChange: (v: string) => void; error: boolean }) {
  const [focused, setFocused] = useState(false);
  const at = Math.min(value.length, 5);
  return (
    <div className="relative mt-2">
      <div className="grid grid-cols-6 gap-2" aria-hidden>
        {Array.from({ length: 6 }, (_, i) => {
          const d = value[i];
          const active = focused && i === at;
          return (
            <div
              key={i}
              className={cx(
                "grid h-16 place-items-center rounded-[var(--radius-ctl)] border-2 font-mono text-3xl font-black tabular-nums transition-[border-color,background-color,transform] duration-[var(--dur-2)] ease-[var(--ease-out)]",
                error ? "border-danger/70 bg-ink-2" : active ? "-translate-y-0.5 border-gold bg-ink-2" : d ? "border-gold/30 bg-ink-3" : "border-line bg-ink-2",
              )}
            >
              {d ? (
                <span key={`${i}-${d}`} className="m-pop">
                  {d}
                </span>
              ) : active ? (
                <span className="p-caret h-8 w-0.5 rounded bg-gold" />
              ) : null}
            </div>
          );
        })}
      </div>
      <input
        className="absolute inset-0 h-full w-full cursor-text text-base caret-transparent opacity-0"
        aria-labelledby="pin-label"
        inputMode="numeric"
        autoComplete="off"
        value={value}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
      />
    </div>
  );
}
