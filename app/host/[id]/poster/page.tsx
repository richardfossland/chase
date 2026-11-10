import type { Metadata } from "next";

import PosterSheet from "./PosterSheet";

export const metadata: Metadata = { title: "QR-poster — Chase", robots: { index: false } };

export default async function PosterPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PosterSheet sessionId={id} />;
}
