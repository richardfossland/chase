import type { Metadata, Viewport } from "next";

import JoinForm from "../JoinForm";

export const viewport: Viewport = { themeColor: "#0e1117" };
export const metadata: Metadata = { title: "Bli med — Chase" };

export default async function JoinPinPage({ params }: { params: Promise<{ pin: string }> }) {
  const { pin } = await params;
  return <JoinForm initialPin={/^\d{6}$/.test(pin) ? pin : undefined} />;
}
