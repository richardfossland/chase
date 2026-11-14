import type { Metadata, Viewport } from "next";

import JoinForm from "./JoinForm";

export const viewport: Viewport = { themeColor: "#0e1117" };
export const metadata: Metadata = { title: "Bli med — Chase" };

export default function JoinPage() {
  return <JoinForm />;
}
