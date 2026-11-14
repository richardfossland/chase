"use client";

export default function PrintButton({ label }: { label: string }) {
  return (
    <button
      className="ui-press min-h-12 rounded-[var(--radius-ctl)] bg-[#14171e] px-5 font-extrabold text-white hover:bg-[#2a2f3a] print:hidden"
      onClick={() => window.print()}
    >
      {label}
    </button>
  );
}
