import type { Metadata } from "next";
import { Suspense } from "react";

import PlayView from "./PlayView";

export const metadata: Metadata = { title: "Chase" };

export default async function PlayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense>
      <PlayView sessionId={id} />
    </Suspense>
  );
}
