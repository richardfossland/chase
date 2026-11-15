"use client";

import { IconPrinter } from "@/lib/client/ui/icons";

export default function PrintButton({ label }: { label: string }) {
  return (
    <button
      className="ui-press inline-flex min-h-12 items-center gap-2 rounded-[var(--radius-ctl)] bg-[#14171e] px-5 font-extrabold text-white hover:bg-[#2a2f3a] print:hidden"
      onClick={() => window.print()}
    >
      <IconPrinter size={18} />
      {label}
    </button>
  );
}
