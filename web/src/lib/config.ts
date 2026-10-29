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
/**
 * The Windows installer of the latest release (desktop/). The release workflow uploads it
 * under this fixed name next to the versioned one, with its SHA-256 and build provenance.
 */
/** The released version (from CHANGELOG.md at build time), e.g. "1.2.2.20261025"; "" if unknown. */
export const APP_VERSION = process.env.APP_VERSION ?? "";
export const RELEASES_URL = "https://github.com/Fitesip/etherdisk/releases";

export const WINDOWS_DOWNLOAD_URL = "https://github.com/Fitesip/etherdisk/releases/latest/download/Etherdisk-windows-x64-setup.exe";
export const WC_PROJECT_ID = process.env.NEXT_PUBLIC_WC_PROJECT_ID || undefined;

/** Passphrase policy for new passphrases (the crypto crate only rejects empty ones). */
export const MIN_PASSPHRASE_LENGTH = 8;
export const MAX_DRIVE_NAME = 64;
