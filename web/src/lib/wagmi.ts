import type { Transport } from "viem";
import { createConfig, fallback, http } from "wagmi";
import { injected, walletConnect } from "wagmi/connectors";

import { CHAIN } from "./chain";
import { RPC_URLS, siteUrl, WC_PROJECT_ID } from "./config";

// Browser wallets (MetaMask, Rabby, ...) are discovered via EIP-6963 automatically;
// `injected()` is the fallback for wallets that don't announce themselves.
export const wagmiConfig = createConfig({
  chains: [CHAIN],
  connectors: [
    injected(),
    ...(WC_PROJECT_ID
      ? [
          walletConnect({
            projectId: WC_PROJECT_ID,
            metadata: {
              name: "Etherdisk",
              description: "Encrypted storage you own as an NFT",
              url: siteUrl(),
              // Shown by the wallet next to connection and signature requests.
              icons: typeof window === "undefined" ? [] : [`${siteUrl()}/icons/icon-192.png`],
            },
          }),
        ]
      : []),
  ],
  // Several endpoints: the next one takes over when one fails.
  transports: { [CHAIN.id]: RPC_URLS.length ? fallback(RPC_URLS.map((url) => http(url))) : http() } as Record<typeof CHAIN.id, Transport>,
  ssr: true,
});

export { CHAIN };

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
