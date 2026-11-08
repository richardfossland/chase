import type { Metadata } from "next";

import HostLobby from "./HostLobby";

export const metadata: Metadata = { title: "Lærer — Chase" };

export default async function HostPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <HostLobby sessionId={id} />;
}
