import type { Metadata, Viewport } from "next";

import QrClaim from "./QrClaim";

export const viewport: Viewport = { themeColor: "#0e1117" };
export const metadata: Metadata = { title: "Post – Chase", robots: { index: false } };

// A physical QR post opened with the phone's own camera app (PLAN §3.1).
export default async function Page({ params }: { params: Promise<{ id: string; code: string }> }) {
  const { id, code } = await params;
  return <QrClaim sessionId={id} code={code} />;
}
