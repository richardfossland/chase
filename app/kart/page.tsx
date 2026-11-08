import type { Metadata } from "next";

import { no } from "@/lib/locale/no";

import AreaMapDemo from "./AreaMapDemo";

export const metadata: Metadata = { title: `${no.map.title} — Chase` };

export default function KartPage() {
  return <AreaMapDemo />;
}
