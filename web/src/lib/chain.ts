// The network the app works on, from `NEXT_PUBLIC_CHAIN_ID` (inlined at build time):
// Ethereum mainnet (1) or Sepolia (11155111, the default). The server's CHAIN_ID must match.

import { mainnet, sepolia } from "viem/chains";

const SUPPORTED = { [mainnet.id]: mainnet, [sepolia.id]: sepolia } as const;
const id = Number(process.env.NEXT_PUBLIC_CHAIN_ID || sepolia.id);

function pick() {
  const chain = SUPPORTED[id as keyof typeof SUPPORTED];
  if (!chain) throw new Error(`NEXT_PUBLIC_CHAIN_ID=${id} is not supported: use 1 (mainnet) or 11155111 (Sepolia)`);
  return chain;
}

export const CHAIN = pick();
export const IS_TESTNET = CHAIN.testnet === true;

/** A drive token on the network's block explorer (Etherscan). */
export const explorerNftUrl = (contract: string, tokenId: string) => `${CHAIN.blockExplorers.default.url}/nft/${contract}/${tokenId}`;
