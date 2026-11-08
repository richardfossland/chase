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
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      onClick={onCancel}
    >
      <div className="w-full max-w-sm rounded-2xl border border-line bg-ink-2 p-5 text-center" onClick={(e) => e.stopPropagation()}>
        <p className="text-lg font-bold">{message}</p>
        <div className="mt-5 flex justify-center gap-3">
          <button
            className={`min-h-12 rounded-xl px-5 font-extrabold ${danger ? "bg-danger text-white" : "bg-gold text-ink"}`}
            autoFocus
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
          <button className="min-h-12 rounded-xl border border-line px-5 font-bold text-txt" onClick={onCancel}>
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
