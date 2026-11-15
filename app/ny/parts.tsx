"use client";

// Small presentation pieces shared by the wizard steps.

import { useId } from "react";

import { cx } from "@/lib/client/ui";
import { IconAlert, IconChevronDown } from "@/lib/client/ui/icons";

export const field =
  "w-full min-h-12 rounded-[var(--radius-ctl)] border border-line bg-ink px-4 py-2.5 outline-none transition-[border-color,box-shadow] duration-[var(--dur-1)] focus:border-gold-deep focus:ring-4 focus:ring-gold/20";

/** Selectable chip-button (minutes, counts, pickers). */
export function choice(on: boolean, extra?: string) {
  return cx(
    "ui-press min-h-12 rounded-[var(--radius-ctl)] px-3 text-sm font-extrabold disabled:opacity-40",
    on ? "bg-gold text-on-accent shadow-[var(--shadow-card)]" : "border border-line bg-ink-2 text-txt hover:bg-ink-3",
    extra,
  );
}

/** One half of a segmented control. */
export function segment(on: boolean) {
  return cx(
    "ui-press inline-flex min-h-12 flex-1 items-center justify-center gap-2 rounded-[0.7rem] px-3 text-sm font-extrabold",
    on ? "bg-ink-2 text-txt shadow-[var(--shadow-card)]" : "text-txt-dim hover:text-txt",
  );
}

/** Large selectable card (Kahoot-style). */
export function card(on: boolean, extra?: string) {
  return cx(
    "ui-press flex min-h-24 w-full min-w-0 flex-col items-start rounded-2xl border-2 p-4 text-left",
    on ? "border-gold bg-gold/10 shadow-[var(--shadow-card)]" : "border-line bg-ink-2 hover:border-gold/60 hover:bg-ink",
    extra,
  );
}

export const iconBtn =
  "ui-press grid size-12 flex-none place-items-center rounded-[var(--radius-ctl)] text-txt-dim hover:bg-ink-3 hover:text-txt disabled:opacity-30";

export function Note({ tone, alert, children }: { tone: "warn" | "danger"; alert?: boolean; children: React.ReactNode }) {
  return (
    <p
      className={cx(
        "m-rise-in mt-4 flex items-start gap-2.5 rounded-xl px-3.5 py-2.5 text-sm leading-relaxed font-semibold",
        tone === "warn" ? "bg-warn/15 text-warn-text" : "bg-danger/10 text-danger-text",
      )}
      role={alert ? "alert" : undefined}
    >
      <IconAlert size={18} className="mt-0.5 flex-none" />
      <span className="min-w-0 flex-1">{children}</span>
    </p>
  );
}

/** Back/next row that sticks to the bottom of a scrolling sheet. */
export function SheetFooter({ children, plain }: { children: React.ReactNode; plain?: boolean }) {
  return (
    <div
      className={cx(
        "flex items-center justify-between gap-3",
        plain ? "mt-3" : "sticky bottom-0 -mx-6 -mb-6 mt-6 border-t border-line bg-ink-2/95 px-6 py-3 backdrop-blur",
      )}
    >
      {children}
    </div>
  );
}

/** Label + on/off switch row. */
export function Switch(props: { label: string; on: boolean; onChange: (on: boolean) => void; testId?: string; icon?: React.ReactNode }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.on}
      className="ui-press flex min-h-12 w-full items-center gap-3 rounded-[var(--radius-ctl)] px-1 text-left text-sm font-extrabold"
      onClick={() => props.onChange(!props.on)}
      data-testid={props.testId}
    >
      {props.icon && <span className="flex-none text-txt-dim">{props.icon}</span>}
      <span className="min-w-0 flex-1">{props.label}</span>
      <span
        className={cx(
          "relative h-7 w-12 flex-none rounded-full transition-colors duration-[var(--dur-2)]",
          props.on ? "bg-gold" : "bg-ink-3",
        )}
        aria-hidden
      >
        <span
          className={cx(
            "absolute top-1 left-1 size-5 rounded-full bg-white shadow transition-transform duration-[var(--dur-2)] ease-[var(--ease-out)]",
            props.on && "translate-x-5",
          )}
        />
      </span>
    </button>
  );
}

export function Disclosure(props: {
  title: string;
  badge?: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  testId?: string;
  flat?: boolean;
  children: React.ReactNode;
}) {
  const id = useId();
  return (
    <div
      className={cx(
        "mt-4 rounded-2xl transition-colors duration-[var(--dur-2)]",
        props.flat ? "" : cx("border bg-ink-2", props.open ? "border-gold/50" : "border-line"),
      )}
    >
      <button
        type="button"
        className="ui-press flex min-h-14 w-full items-center gap-3 rounded-2xl px-4 text-left hover:bg-ink"
        aria-expanded={props.open}
        aria-controls={id}
        onClick={props.onToggle}
        data-testid={props.testId}
      >
        <span className="min-w-0 flex-1 font-extrabold">{props.title}</span>
        {props.badge}
        <IconChevronDown className="t-chevron flex-none text-txt-dim" />
      </button>
      <div id={id} className="t-collapse" data-open={props.open} inert={!props.open}>
        <div>
          <div className="px-4 pt-1 pb-4">{props.children}</div>
        </div>
      </div>
    </div>
  );
}

export function Label({ children }: { children: React.ReactNode }) {
  return <p className="mt-6 text-sm font-bold">{children}</p>;
}
export function Help({ children }: { children: React.ReactNode }) {
  return <p className="mt-2 text-xs leading-relaxed text-txt-dim">{children}</p>;
}
