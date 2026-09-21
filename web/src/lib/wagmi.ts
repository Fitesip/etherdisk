import { createConfig, fallback, http } from "wagmi";
import { sepolia } from "wagmi/chains";
import { injected, walletConnect } from "wagmi/connectors";

import { RPC_URLS, WC_PROJECT_ID } from "./config";

// Browser wallets (MetaMask, Rabby, ...) are discovered via EIP-6963 automatically;
// `injected()` is the fallback for wallets that don't announce themselves.
export const wagmiConfig = createConfig({
  chains: [sepolia],
  connectors: [
    injected(),
    ...(WC_PROJECT_ID
      ? [
          walletConnect({
            projectId: WC_PROJECT_ID,
            metadata: {
              name: "Etherdisk",
              description: "Encrypted storage you own as an NFT",
              url: typeof window === "undefined" ? "http://localhost:3000" : window.location.origin,
              icons: [],
            },
          }),
        ]
      : []),
  ],
  // Several endpoints: the next one takes over when one fails.
  transports: { [sepolia.id]: RPC_URLS.length ? fallback(RPC_URLS.map((url) => http(url))) : http() },
  ssr: true,
});

export const CHAIN = sepolia;

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
