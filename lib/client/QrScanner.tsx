"use client";

import { useEffect, useRef, useState } from "react";

import { no } from "@/lib/locale/no";

const t = no.qr;

type Detector = { detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]> };

/**
 * Camera QR scanner with a typed-code fallback (decided 2026-11-10).
 * BarcodeDetector where the browser has it (Android Chrome); jsQR on canvas
 * frames elsewhere (iOS Safari). Nothing leaves the phone except the code.
 */
export function QrScanner({ onCode, onClose, busy }: { onCode: (text: string) => void; onClose: () => void; busy: boolean }) {
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
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

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

      const BD = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
      const detector = BD ? new BD({ formats: ["qr_code"] }) : null;
      const jsQR = detector ? null : (await import("jsqr")).default;

      const loop = async () => {
        if (stop) return;
        if (!busyRef.current && v.readyState >= 2) {
          try {
            let text: string | null = null;
            if (detector) {
              const r = await detector.detect(v);
              text = r[0]?.rawValue ?? null;
            } else if (jsQR && ctx) {
              const w = (canvas.width = Math.min(640, v.videoWidth));
              const h = (canvas.height = Math.round((v.videoHeight * w) / v.videoWidth));
              ctx.drawImage(v, 0, 0, w, h);
              text = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "dontInvert" })?.data ?? null;
            }
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
    <div className="absolute inset-0 z-30 flex flex-col bg-ink text-txt" role="dialog" aria-label={t.title}>
      <div className="flex items-center justify-between px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3">
        <h2 className="text-2xl font-black">{t.title}</h2>
        <button className="rounded-xl border border-line px-4 py-2 font-bold" onClick={onClose}>
          {t.close}
        </button>
      </div>
      <div className="relative min-h-0 flex-1 bg-black">
        {camError ? (
          <p className="p-6 text-lg font-bold">{t.noCamera}</p>
        ) : (
          <>
            <video ref={video} className="h-full w-full object-cover" playsInline muted />
            <div className="pointer-events-none absolute inset-0 grid place-items-center">
              <div className="size-60 rounded-3xl border-4 border-gold/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]" />
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
          onChange={(e) => setTyped(e.target.value.toUpperCase())}
          placeholder={t.codePlaceholder}
          maxLength={7}
          autoCapitalize="characters"
          autoComplete="off"
          className="min-w-0 flex-1 rounded-xl border border-line bg-ink-2 px-3 py-3 text-center text-2xl font-black tracking-[0.3em] outline-none focus:border-gold"
          aria-label={t.codeLabel}
        />
        <button className="rounded-xl bg-gold px-5 py-3 text-lg font-extrabold text-ink disabled:opacity-40" disabled={busy || !typed.trim()}>
          {t.send}
        </button>
      </form>
    </div>
  );
}
