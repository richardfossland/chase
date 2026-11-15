"use client";

import { useState } from "react";

import { cx } from "@/lib/client/ui";
import { IconInfo } from "@/lib/client/ui/icons";
import { no } from "@/lib/locale/no";

/** A small (i) button that reveals an explanation the control itself does not give. */
export function InfoNote({ children, className }: { children: React.ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={className}>
      <button
        type="button"
        className={cx(
          "ui-press inline-flex min-h-12 min-w-12 items-center justify-center rounded-full text-txt-dim hover:bg-ink-3 hover:text-txt",
          open && "bg-ink-3 text-txt",
        )}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={no.host.info}
      >
        <IconInfo size={20} />
      </button>
      {open && <p className="m-fade-in mt-1 max-w-prose text-sm leading-relaxed text-txt-dim">{children}</p>}
    </div>
  );
}
