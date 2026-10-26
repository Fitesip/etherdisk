import { CONTRACT_ADDRESS } from "./config";

/** The parts of Etherdisk (ERC-721) the frontend uses. Ownership/capacity reads go through the backend. */
export const vaultNftAbi = [
  {
    type: "event",
    name: "DriveMinted",
    inputs: [
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "owner", type: "address", indexed: true },
      { name: "tierId", type: "uint256", indexed: true },
    ],
  },
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
          { name: "color", type: "uint24" },
          { name: "active", type: "bool" },
          { name: "hidden", type: "bool" },
          { name: "price", type: "uint256" },
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
