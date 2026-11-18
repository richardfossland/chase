"use client";

import { useEffect, useRef, useState } from "react";

import { no } from "@/lib/locale/no";
import { createQrDetector, type Detector } from "@/lib/client/qrDetector";
import { buttonClass } from "@/lib/client/ui";
import { IconArrowRight, IconCamera, IconX } from "@/lib/client/ui/icons";

const t = no.qr;

/**
 * Camera QR scanner with a typed-code fallback (decided 2026-11-10).
 * BarcodeDetector where the browser has it (Android Chrome); the zxing-wasm
 * polyfill (barcode-detector, lazy-loaded) elsewhere (iOS Safari). Nothing leaves the phone except the code.
 */
export function QrScanner({
  onCode,
  onClose,
  busy,
  title = t.title,
  codeLabel = t.codeLabel,
  numeric = false,
}: {
  onCode: (text: string) => void;
  onClose: () => void;
  busy: boolean;
  title?: string;
  codeLabel?: string;
  numeric?: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [camError, setCamError] = useState(false);
  const [typed, setTyped] = useState("");
  const busyRef = useRef(busy);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      } catch {
        setCamError(true);
        return;
      }
      const v = video.current;
      if (!v || stop) return;
      v.srcObject = stream;
      await v.play().catch(() => {});

      let detector: Detector;
      try {
        detector = await createQrDetector();
      } catch {
        return; // typed-code fallback still works
      }
      if (stop) return;

      const loop = async () => {
        if (stop) return;
        if (!busyRef.current && v.readyState >= 2) {
          try {
            const r = await detector.detect(v);
            const text = r[0]?.rawValue ?? null;
            if (text) onCode(text);
          } catch {
            /* next frame */
          }
        }
        timer = setTimeout(loop, 200);
      };
      void loop();
    })();

    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, [onCode]);

  return (
    <div className="m-fade-in absolute inset-0 z-30 flex flex-col bg-ink text-txt" role="dialog" aria-label={title}>
      <div className="flex items-center justify-between gap-3 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3">
        <h2 className="text-2xl font-black">{title}</h2>
        <button className={buttonClass("secondary", "lg", "flex-none")} onClick={onClose}>
          <IconX size={20} />
          {t.close}
        </button>
      </div>
      <div className="relative min-h-0 flex-1 bg-black">
        {camError ? (
          <div className="flex flex-col items-start gap-3 p-6">
            <IconCamera size={36} className="text-txt-dim" />
            <p className="text-lg font-bold">{t.noCamera}</p>
          </div>
        ) : (
          <>
            <video ref={video} className="h-full w-full object-cover" playsInline muted />
            <div className="pointer-events-none absolute inset-0 grid place-items-center">
              <div className="m-scale-in size-60 rounded-3xl border-4 border-gold/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]" />
            </div>
          </>
        )}
      </div>
      <form
        className="flex gap-2 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
        onSubmit={(e) => {
          e.preventDefault();
          if (typed.trim()) onCode(typed);
        }}
      >
        <input
          value={typed}
          onChange={(e) => setTyped(numeric ? e.target.value.replace(/\D/g, "") : e.target.value.toUpperCase())}
          placeholder={numeric ? "0000" : t.codePlaceholder}
          maxLength={numeric ? 4 : 7}
          inputMode={numeric ? "numeric" : "text"}
          autoCapitalize="characters"
          autoComplete="off"
          className="min-h-14 min-w-0 flex-1 rounded-[var(--radius-ctl)] border-2 border-line bg-ink-2 px-3 py-3 text-center text-2xl font-black tracking-[0.3em] outline-none transition-colors focus:border-gold"
          aria-label={codeLabel}
        />
        <button className={buttonClass("primary", "lg", "flex-none")} disabled={busy || !typed.trim()}>
          {t.send}
          <IconArrowRight size={20} />
        </button>
      </form>
    </div>
  );
}
