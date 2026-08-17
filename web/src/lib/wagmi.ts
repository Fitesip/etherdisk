import { createConfig, http } from "wagmi";
import { sepolia } from "wagmi/chains";
import { injected, walletConnect } from "wagmi/connectors";

import { RPC_URL, WC_PROJECT_ID } from "./config";

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
              name: "NFT Vault",
              description: "Encrypted storage you own as an NFT",
              url: typeof window === "undefined" ? "http://localhost:3000" : window.location.origin,
              icons: [],
            },
          }),
        ]
      : []),
  ],
  transports: { [sepolia.id]: http(RPC_URL) },
  ssr: true,
});

export const CHAIN = sepolia;

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
