import type { Metadata } from "next";

import DemoLifecycle from "./DemoLifecycle";
import HostPanel from "./HostPanel";

export const metadata: Metadata = { title: "Lærer — Chase" };

export default async function HostPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <>
      <DemoLifecycle sessionId={id} />
      <HostPanel sessionId={id} />
    </>
  );
}
