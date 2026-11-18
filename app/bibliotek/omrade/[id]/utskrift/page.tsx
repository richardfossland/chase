import type { Metadata } from "next";

import PrintSheet from "./PrintSheet";

export const metadata: Metadata = { title: "QR-kort — Chase", robots: { index: false } };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PrintSheet areaId={id} />;
}
