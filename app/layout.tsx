import type { Metadata, Viewport } from "next";
import { Hanken_Grotesk } from "next/font/google";
import "./globals.css";

const body = Hanken_Grotesk({
  variable: "--font-body",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800", "900"],
});

export const metadata: Metadata = {
  title: "Chase — GPS-jakt for hele klassen",
  description:
    "Lærerstyrt GPS-jaktspill for skolegården, skogen og sentrum. Elevene blir med via QR — og glemmer at de trener.",
  applicationName: "Chase",
  appleWebApp: { capable: true, title: "Chase", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  themeColor: "#0e1117",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="no" className={body.variable}>
      <body>{children}</body>
    </html>
  );
}
