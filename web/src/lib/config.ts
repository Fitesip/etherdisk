import type { Address } from "viem";

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787").replace(/\/$/, "");
export const CONTRACT_ADDRESS = (process.env.NEXT_PUBLIC_CONTRACT_ADDRESS ?? "") as Address;
/** RPC endpoints (`NEXT_PUBLIC_RPC_URL`, comma-separated), tried in order. Empty = the chain's public default. */
export const RPC_URLS = (process.env.NEXT_PUBLIC_RPC_URL ?? "")
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);
/**
 * The site's own address (`NEXT_PUBLIC_SITE_URL`, e.g. https://etherdisk.app). The desktop app
 * runs from a local origin, so sign-in messages, share links and the wallet metadata name the
 * site instead. Empty: the page's own origin.
 */
export const siteUrl = () =>
  (process.env.NEXT_PUBLIC_SITE_URL || (typeof window === "undefined" ? "http://localhost:3000" : window.location.origin)).replace(/\/$/, "");
export const WC_PROJECT_ID = process.env.NEXT_PUBLIC_WC_PROJECT_ID || undefined;

/** Passphrase policy for new passphrases (the crypto crate only rejects empty ones). */
export const MIN_PASSPHRASE_LENGTH = 8;
export const MAX_DRIVE_NAME = 64;
