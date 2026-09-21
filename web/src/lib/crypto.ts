// Loads the Rust crypto crate (WASM) and small byte helpers. Client-only.

import init from "@/wasm/etherdisk_crypto_wasm";

export {
  WasmFileDecryptor,
  WasmFileEncryptor,
  WasmVault,
  checkRecoveryWords,
  chunkLocation,
  decryptWithKey,
  defaultChunkSize,
  encryptWithKey,
  encryptedLen,
  headerLen,
  inboxOpen,
  inboxPublicKey,
  inboxSeal,
  newRecoveryWords,
  plaintextLen,
} from "@/wasm/etherdisk_crypto_wasm";

let ready: Promise<void> | undefined;

/** Must be awaited before calling anything from the crate. */
export function loadCrypto(): Promise<void> {
  ready ??= init({ module_or_path: "/crypto/etherdisk_crypto_wasm_bg.wasm" }).then(() => undefined);
  return ready;
}

/** Yields to the browser so a "working…" state paints before a blocking call (Argon2). */
export function nextFrame(): Promise<void> {
  return new Promise((r) => setTimeout(r, 30));
}

const enc = new TextEncoder();
const dec = new TextDecoder();
export const utf8 = (s: string) => enc.encode(s);
export const fromUtf8 = (b: Uint8Array) => dec.decode(b);

export function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(b64: string): Uint8Array {
  const s = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** URL-safe, unpadded (for link fragments). */
export const toB64Url = (bytes: Uint8Array) => toB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
