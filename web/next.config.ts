import type { NextConfig } from "next";
import { mainnet, sepolia } from "viem/chains";

const isDev = process.env.NODE_ENV === "development";
// A static export for the desktop app (NEXT_OUTPUT=export): plain HTML, JS and WASM files.
const isExport = process.env.NEXT_OUTPUT === "export";
// Same rule as src/lib/chain.ts: mainnet when NEXT_PUBLIC_CHAIN_ID=1, Sepolia otherwise.
const chain = process.env.NEXT_PUBLIC_CHAIN_ID === "1" ? mainnet : sepolia;
const origin = (url: string | undefined) => {
  try {
    return url ? new URL(url).origin : "";
  } catch {
    return "";
  }
};

// Where the page may connect. Everything else is blocked, so even an injected script
// can't send decrypted data or keys to a third-party server with fetch/XHR/WebSocket.
const connect = [
  "'self'",
  origin(process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787"),
  ...(process.env.NEXT_PUBLIC_RPC_URL || chain.rpcUrls.default.http[0]).split(",").map((u) => origin(u.trim())),
  // WalletConnect relay and verify API.
  "https://*.walletconnect.com",
  "wss://*.walletconnect.com",
  "https://*.walletconnect.org",
  "wss://*.walletconnect.org",
  "https://*.reown.com",
  "wss://*.reown.com",
  // The WalletConnect modal's wallet list and wallet logos.
  "https://api.web3modal.org",
  "https://api.web3modal.com",
  ...(isDev ? ["ws://localhost:*", "http://127.0.0.1:*", "http://localhost:*"] : []),
].filter(Boolean);

// Scripts: 'unsafe-inline' remains because Next.js streams inline scripts and a nonce
// would force every page to render per request (no partial prerendering). The other
// directives still cut off most of what an injected script could do.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  // Wallet logos in the WalletConnect modal (fetched as blobs, some as plain images).
  "img-src 'self' blob: data: https://*.walletconnect.com https://*.walletconnect.org https://*.reown.com https://api.web3modal.org https://imagedelivery.net",
  "media-src 'self' blob:",
  "font-src 'self' https://fonts.reown.com",
  `connect-src ${connect.join(" ")}`,
  "frame-src 'self' blob: https://verify.walletconnect.com https://verify.walletconnect.org https://secure.walletconnect.org https://secure.walletconnect.com",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  // The Docker image runs the self-contained server (deploy/web.Dockerfile sets NEXT_OUTPUT).
  ...(process.env.NEXT_OUTPUT === "standalone" && { output: "standalone" as const }),
  ...(isExport && { output: "export" as const }),
  // Partial prerendering needs a server.
  cacheComponents: !isExport,
  partialPrefetching: !isExport,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
      // Legal texts (src/legal/*.md) are imported as strings.
      "*.md": { type: "text" },
    },
  },
  // A static export (the desktop app) has no server to send headers: its pages carry the
  // same policy in a <meta> tag (where frame-ancestors doesn't apply).
  ...(isExport ? { env: { EXPORT_CSP: csp.replace("; frame-ancestors 'none'", "") } } : { headers }),
};

async function headers() {
  return [
    {
      source: "/(.*)",
      headers: [
        { key: "Content-Security-Policy", value: csp },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(), payment=()" },
      ],
    },
    {
      // The service worker must be able to control the whole site.
      source: "/sw.js",
      headers: [{ key: "Service-Worker-Allowed", value: "/" }],
    },
  ];
}

export default nextConfig;
