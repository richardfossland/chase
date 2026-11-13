"use client";

export default function PrintButton({ label }: { label: string }) {
  return (
    <button className="rounded-xl bg-[#14171e] px-5 py-3 font-extrabold text-white print:hidden" onClick={() => window.print()}>
      {label}
    </button>
  );
}
