import type { Metadata, Viewport } from "next";

import CodeClaim from "./CodeClaim";

export const viewport: Viewport = { themeColor: "#0e1117" };
export const metadata: Metadata = { title: "Post – Chase", robots: { index: false } };

// A fixed area post's printed card (0016): /q/<CODE>. The segment is named
// [id] only because it sits beside /q/[id]/[code]; here it holds the 5-char code.
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CodeClaim code={id} />;
}
