import type { Metadata } from "next";

import JoinForm from "../JoinForm";

export const metadata: Metadata = { title: "Bli med — Chase" };

export default async function JoinPinPage({ params }: { params: Promise<{ pin: string }> }) {
  const { pin } = await params;
  return <JoinForm initialPin={/^\d{6}$/.test(pin) ? pin : undefined} />;
}
