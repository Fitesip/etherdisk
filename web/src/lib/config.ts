import type { Address } from "viem";

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787").replace(/\/$/, "");
export const CONTRACT_ADDRESS = (process.env.NEXT_PUBLIC_CONTRACT_ADDRESS ?? "") as Address;
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || undefined;
export const WC_PROJECT_ID = process.env.NEXT_PUBLIC_WC_PROJECT_ID || undefined;

/** Passphrase policy (the crypto crate only rejects empty ones). */
export const MIN_PASSPHRASE_LENGTH = 12;
