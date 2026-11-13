import type { Metadata } from "next";

import LibraryView from "./LibraryView";

export const metadata: Metadata = { title: "Bibliotek — Chase", robots: { index: false } };

export default function Page() {
  return <LibraryView />;
}
