// Opening and downloading encrypted files. Prefers the streaming service worker
// (public/sw.js); without it, decrypts the whole file into memory.

import { concat, fromB64, headerLen, plaintextLen, WasmFileDecryptor, chunkLocation, type WasmVault } from "./crypto";
import { contentUrl, shareContentUrl, type ObjectRow } from "./api";
import type { FileMeta } from "./meta";

export interface StreamSource {
  /** Absolute URL of the ciphertext (supports Range). */
  url: string;
  /** Bearer token for owner URLs; share URLs need none. */
  token?: string | null;
  key: Uint8Array;
  encSize: number;
  name: string;
  type: string;
}

export const ownerSource = (token: string, tokenId: string, vault: WasmVault, row: ObjectRow, meta: FileMeta): StreamSource => ({
  url: contentUrl(tokenId, row.id),
  token,
  key: vault.fileKey(fromB64(meta.header)),
  encSize: row.size,
  name: meta.name,
  type: meta.type,
});

export const shareSource = (shareId: string, f: { id: string; key: string; encSize: number; name: string; type: string }): StreamSource => ({
  url: shareContentUrl(shareId, f.id),
  key: fromB64(f.key),
  encSize: f.encSize,
  name: f.name,
  type: f.type,
});

let swPromise: Promise<boolean> | undefined;

/** Registers the worker once; resolves to whether it controls this page. */
export function initServiceWorker(): Promise<boolean> {
  swPromise ??= (async () => {
    if (!("serviceWorker" in navigator)) return false;
    try {
      await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        // First visit: the worker claims the page right after activating.
        await new Promise((r) => {
          navigator.serviceWorker.addEventListener("controllerchange", r, { once: true });
          setTimeout(r, 3000);
        });
      }
      return !!navigator.serviceWorker.controller;
    } catch {
      return false;
    }
  })();
  return swPromise;
}

/** Same-origin URL served by the worker, or null if streaming is unavailable. */
export async function registerStream(src: StreamSource): Promise<string | null> {
  if (!(await initServiceWorker())) return null;
  const sw = navigator.serviceWorker.controller;
  if (!sw) return null;
  const id = crypto.randomUUID();
  await new Promise<void>((resolve, reject) => {
    const ch = new MessageChannel();
    const timer = setTimeout(() => reject(new Error("service worker did not answer")), 3000);
    ch.port1.onmessage = () => {
      clearTimeout(timer);
      resolve();
    };
    sw.postMessage({ type: "register", id, stream: src }, [ch.port2]);
  });
  return `/__stream/${id}`;
}

/** Fallback: fetch and decrypt everything in memory. */
export async function decryptToBlob(src: StreamSource): Promise<Blob> {
  const res = await fetch(src.url, { headers: src.token ? { Authorization: `Bearer ${src.token}` } : {} });
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const data = new Uint8Array(await res.arrayBuffer());
  const dec = WasmFileDecryptor.fromKey(src.key, data.subarray(0, headerLen()));
  try {
    const cs = dec.chunkSize;
    const encSize = BigInt(data.length);
    const chunks = Math.max(1, Math.ceil(Number(plaintextLen(encSize, cs)) / cs));
    const parts: Uint8Array[] = [];
    for (let i = 0; i < chunks; i++) {
      const [off, len, last] = chunkLocation(i, cs, encSize);
      parts.push(dec.decryptChunk(i, data.subarray(Number(off), Number(off + len)), last === 1n));
    }
    return new Blob([concat(parts)], { type: src.type });
  } finally {
    dec.free();
  }
}

/** URL to show the file in <img>/<video>/<iframe>. Blob URLs must be revoked by the caller. */
export async function openUrl(src: StreamSource): Promise<{ url: string; blob: boolean }> {
  const url = await registerStream(src).catch(() => null);
  if (url) return { url, blob: false };
  return { url: URL.createObjectURL(await decryptToBlob(src)), blob: true };
}

/** Saves the decrypted file under its original name. */
export async function downloadFile(src: StreamSource): Promise<void> {
  const streamed = await registerStream(src).catch(() => null);
  const a = document.createElement("a");
  if (streamed) {
    a.href = `${streamed}?dl=1`;
  } else {
    a.href = URL.createObjectURL(await decryptToBlob(src));
    a.download = src.name;
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  }
  document.body.append(a);
  a.click();
  a.remove();
}
