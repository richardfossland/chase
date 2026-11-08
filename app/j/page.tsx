import type { Metadata } from "next";

import JoinForm from "./JoinForm";

export const metadata: Metadata = { title: "Bli med — Chase" };

export default function JoinPage() {
  return <JoinForm />;
}
