import { CONTRACT_ADDRESS } from "./config";

/** The parts of Etherdisk (ERC-721) the frontend uses. Ownership/capacity reads go through the backend. */
export const vaultNftAbi = [
  {
    type: "function",
    name: "tierCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getTier",
    stateMutability: "view",
    inputs: [{ name: "tierId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "capacityGb", type: "uint32" },
          { name: "price", type: "uint256" },
          { name: "active", type: "bool" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "safeTransferFrom",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "mint",
    stateMutability: "payable",
    inputs: [{ name: "tierId", type: "uint256" }],
    outputs: [{ name: "tokenId", type: "uint256" }],
  },
] as const;

export const vaultNft = { address: CONTRACT_ADDRESS, abi: vaultNftAbi } as const;
