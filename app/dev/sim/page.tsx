import type { Metadata } from "next";
import { notFound } from "next/navigation";

import SimPanel from "./SimPanel";

export const metadata: Metadata = { title: "Simulator — Chase", robots: { index: false } };
export const dynamic = "force-dynamic";

// PLAN §9.6: only in development, or when SIM_ENABLED=1 on the server.
export default function SimPage() {
  if (process.env.NODE_ENV === "production" && process.env.SIM_ENABLED !== "1") notFound();
  return <SimPanel />;
}
