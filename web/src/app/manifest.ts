import type { MetadataRoute } from "next";

// Installable app (PWA). The service worker in public/sw.js already controls the site.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "NFT Vault",
    short_name: "NFT Vault",
    description: "Encrypted cloud storage you buy once and own as an NFT.",
    start_url: "/drive",
    scope: "/",
    display: "standalone",
    background_color: "#0b0b0d",
    theme_color: "#4f46e5",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
