// Plain class helpers: no "use client", so server components can use them too.

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/* ── Button ─────────────────────────────────────────────────────────── */
export type Variant = "primary" | "secondary" | "ghost" | "danger" | "hunter" | "ok";
export type Size = "sm" | "md" | "lg" | "xl";

const VARIANT: Record<Variant, string> = {
  primary: "bg-gold text-on-accent shadow-[var(--shadow-card)] hover:bg-gold-light",
  secondary: "border border-line bg-ink-2 text-txt hover:bg-ink-3",
  ghost: "text-txt hover:bg-ink-3",
  danger: "bg-danger text-white hover:brightness-110",
  hunter: "bg-hunter text-white hover:brightness-110",
  ok: "bg-ok text-on-accent hover:brightness-105",
};
const SIZE: Record<Size, string> = {
  sm: "min-h-9 px-3 text-sm font-bold rounded-[0.7rem]",
  md: "min-h-12 px-5 font-extrabold rounded-[var(--radius-ctl)]",
  lg: "min-h-14 px-6 text-lg font-extrabold rounded-2xl",
  xl: "min-h-16 px-6 text-xl font-black rounded-2xl",
};

/** Class string for button-looking links (<Link>, <a>). */
export function buttonClass(variant: Variant = "primary", size: Size = "md", extra?: string): string {
  return cx(
    "ui-press inline-flex items-center justify-center gap-2 text-center select-none disabled:opacity-40 disabled:pointer-events-none",
    VARIANT[variant],
    SIZE[size],
    extra,
  );
}
