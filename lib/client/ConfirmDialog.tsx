"use client";

import { useEffect } from "react";
import { no } from "@/lib/locale/no";

/** Themed yes/no dialog — a touch-friendly, on-brand replacement for the
 * browser's window.confirm (which renders as a tiny OS popup, easy to miss on a
 * phone in the sun). Enter = confirm, Esc / backdrop = cancel. The confirm
 * button is autofocused. */
export function ConfirmDialog({
  message,
  confirmLabel = no.common.confirm,
  cancelLabel = no.common.cancel,
  danger = false,
  onConfirm,
  onCancel,
}: {
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        onConfirm();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onConfirm, onCancel]);

  return (
    <div
      className="m-fade-in fixed inset-0 z-50 grid place-items-center bg-black/45 p-4"
      role="dialog"
      aria-modal="true"
      onClick={onCancel}
    >
      <div className="m-scale-in w-full max-w-sm rounded-[var(--radius-card)] bg-ink-2 p-6 text-center shadow-[var(--shadow-float)]" onClick={(e) => e.stopPropagation()}>
        <p className="text-lg font-bold">{message}</p>
        <div className="mt-5 flex justify-center gap-3">
          <button
            className={`ui-press min-h-12 rounded-[var(--radius-ctl)] px-5 font-extrabold ${danger ? "bg-danger text-white" : "bg-gold text-on-accent"}`}
            autoFocus
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
          <button className="ui-press min-h-12 rounded-[var(--radius-ctl)] border border-line px-5 font-bold text-txt hover:bg-ink-3" onClick={onCancel}>
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
