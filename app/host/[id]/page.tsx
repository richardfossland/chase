import type { Metadata } from "next";

import HostPanel from "./HostPanel";

export const metadata: Metadata = { title: "Lærer — Chase" };

export default async function HostPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <HostPanel sessionId={id} />;
}
