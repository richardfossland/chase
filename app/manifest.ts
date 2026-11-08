import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Chase — GPS-jakt for hele klassen",
    short_name: "Chase",
    description: "Lærerstyrt GPS-jaktspill for kroppsøving og ungdomsgrupper.",
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0e1117",
    theme_color: "#0e1117",
    lang: "no",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
