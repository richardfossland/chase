import type { Metadata } from "next";

import BigScreen from "./BigScreen";

export const metadata: Metadata = { title: "Storskjerm — Chase", robots: { index: false } };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <BigScreen sessionId={id} />;
}
