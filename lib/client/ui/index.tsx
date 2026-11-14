"use client";

import { useEffect, useMemo } from "react";
import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";

import { prefersReducedMotion, usePresence } from "./motion";

export { prefersReducedMotion, useChangeKey, useCountUp, usePresence } from "./motion";

import { buttonClass, cx } from "./classes";
import type { Size, Variant } from "./classes";

export { buttonClass, cx } from "./classes";

/* ── Button ─────────────────────────────────────────────────────────── */
export function Button({
  variant = "primary",
  size = "md",
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return <button type="button" {...rest} className={buttonClass(variant, size, className)} />;
}

/* ── Card ───────────────────────────────────────────────────────────── */
export function Card({
  children,
  className,
  flat,
  ...rest
}: { children: ReactNode; className?: string; flat?: boolean } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={cx(
        "rounded-[var(--radius-card)] bg-ink-2 p-5",
        flat ? "border border-line" : "shadow-[var(--shadow-card)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

/* ── Chip ───────────────────────────────────────────────────────────── */
type ChipTone = "neutral" | "ok" | "warn" | "danger" | "gold";
const CHIP: Record<ChipTone, string> = {
  neutral: "bg-ink-3 text-txt-dim",
  ok: "bg-ok/15 text-ok-text",
  warn: "bg-warn/20 text-warn-text",
  danger: "bg-danger/15 text-danger-text",
  gold: "bg-gold/20 text-gold-text",
};
export function Chip({ children, tone = "neutral", className }: { children: ReactNode; tone?: ChipTone; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold", CHIP[tone], className)}>
      {children}
    </span>
  );
}

/* ── Stepper ────────────────────────────────────────────────────────── */
export function Stepper({ count, index, label }: { count: number; index: number; label?: string }) {
  return (
    <div className="flex items-center gap-3">
      <ol className="flex flex-1 gap-1.5" aria-hidden>
        {Array.from({ length: count }, (_, i) => (
          <li key={i} className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink-3">
            <span
              className="block h-full origin-left rounded-full bg-gold transition-transform duration-[var(--dur-3)] ease-[var(--ease-out)]"
              style={{ transform: `scaleX(${i <= index ? 1 : 0})` }}
            />
          </li>
        ))}
      </ol>
      {label && (
        <span className="text-sm font-bold" aria-live="polite">
          {label}
        </span>
      )}
    </div>
  );
}

/* ── Sheet (bottom sheet on phones, centred card on lg) ─────────────── */
export function Sheet({
  open,
  onClose,
  children,
  closeLabel = "Lukk",
  title,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  closeLabel?: string;
  title?: ReactNode;
}) {
  // Keep the last children while the exit animation runs.
  const { item, leaving } = usePresence(open ? children : null, 200);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!item) return null;
  return (
    <div
      className={cx("fixed inset-0 z-40 flex items-end bg-black/35 lg:items-center lg:justify-center", leaving ? "m-fade-out" : "m-fade-in")}
      onClick={onClose}
    >
      <div
        className={cx(
          "max-h-[82dvh] w-full overflow-y-auto rounded-t-[1.75rem] bg-ink-2 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-[var(--shadow-float)] lg:max-w-md lg:rounded-[1.75rem]",
          leaving ? "ui-sheet-out" : "ui-sheet-in",
        )}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-ink-3 lg:hidden" aria-hidden />
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="text-lg font-black">{title}</div>
          <button type="button" className="ui-press rounded-full px-2 py-1 text-sm font-bold text-txt-dim hover:bg-ink-3" onClick={onClose}>
            {closeLabel} ✕
          </button>
        </div>
        {item}
      </div>
    </div>
  );
}

/* ── Toast (top banner) ─────────────────────────────────────────────── */
/** Pass `toast` = null to dismiss; the banner animates out by itself. */
export function Toast({ toast }: { toast: { id: number | string; label?: string; text: string } | null }) {
  const { item, leaving } = usePresence(toast, 200);
  if (!item) return null;
  return (
    <div
      key={item.id}
      className={cx(
        "absolute inset-x-3 top-[max(0.75rem,env(safe-area-inset-top))] z-30 rounded-2xl border border-gold/60 bg-ink-2 p-4 shadow-[var(--shadow-float)]",
        leaving ? "m-drop-out" : "m-drop-in",
      )}
      role="status"
    >
      {item.label && <p className="text-xs font-bold uppercase tracking-wide text-gold-text">{item.label}</p>}
      <p className="mt-1 text-xl font-black">{item.text}</p>
    </div>
  );
}

/* ── Confetti (pupil celebration; pure CSS, no canvas) ──────────────── */
const CONFETTI = ["#ebb84b", "#ff5a4e", "#3d9bff", "#4fd18b", "#f2d58a", "#ffffff"];
function confettiBits(pieces: number, seed: number) {
  let s = seed * 9301 + 49297;
  const rnd = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  return Array.from({ length: pieces }, (_, i) => ({
    i,
    left: rnd() * 100,
    delay: rnd() * 0.9,
    dur: 2.2 + rnd() * 1.8,
    dx: `${(rnd() - 0.5) * 40}vw`,
    rot: `${360 + rnd() * 720}deg`,
    w: 6 + rnd() * 6,
    color: CONFETTI[Math.floor(rnd() * CONFETTI.length)],
  }));
}

export function Confetti({ pieces = 60, seed = 1 }: { pieces?: number; seed?: number }) {
  const bits = useMemo(() => confettiBits(pieces, seed), [pieces, seed]);
  if (prefersReducedMotion()) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-30 overflow-hidden" aria-hidden>
      {bits.map((b) => (
        <span
          key={b.i}
          className="absolute top-0 block rounded-[2px]"
          style={
            {
              left: `${b.left}%`,
              width: b.w,
              height: b.w * 1.6,
              background: b.color,
              animation: `m-confetti ${b.dur}s linear ${b.delay}s both`,
              "--dx": b.dx,
              "--rot": b.rot,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}
