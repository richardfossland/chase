"use client";

import { useEffect, useState } from "react";
import QR from "qrcode";

/** Renders a QR code for `value` as an <img>. Generated client-side. */
export function QRCode({ value, size = 200 }: { value: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    QR.toDataURL(value, {
      width: size,
      margin: 1,
      color: { dark: "#14171e", light: "#faf7f0" },
    })
      .then((url) => !cancelled && setSrc(url))
      .catch(() => !cancelled && setSrc(null));
    return () => {
      cancelled = true;
    };
  }, [value, size]);

  if (!src)
    return (
      <div
        style={{
          width: size,
          minHeight: size,
          borderRadius: 12,
          background: "var(--color-ink-3)",
          display: "grid",
          placeItems: "center",
          padding: 8,
          fontFamily: "ui-monospace, monospace",
          fontSize: 10,
          lineHeight: 1.3,
          wordBreak: "break-all",
          textAlign: "center",
          color: "var(--color-txt-dim)",
        }}
      >
        {value.replace(/^https?:\/\//, "")}
      </div>
    );
  return (
    // eslint-disable-next-line @next/next/no-img-element -- data-URL QR; next/image cannot optimise it
    <img
      src={src}
      width={size}
      height={size}
      alt="QR-kode for å bli med"
      style={{ borderRadius: 12, background: "#faf7f0" }}
    />
  );
}
