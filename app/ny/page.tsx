import type { Metadata } from "next";

import Wizard from "./Wizard";

export const metadata: Metadata = { title: "Ny økt — Chase" };

export default function NewSessionPage() {
  return <Wizard />;
}
