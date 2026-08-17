"use client";

import { useEffect, useState } from "react";

import { decryptWithKey } from "./crypto";

// Decrypted thumbnails as blob URLs, kept for the tab's lifetime (they are tiny).
const cache = new Map<string, Promise<string | null>>();

/**
 * Loads and decrypts a thumbnail once per `cacheKey`.
 * `load` returns the encrypted bytes and the file key, or null if there is no thumbnail.
 */
export function useThumbnail(
  cacheKey: string | null,
  load: () => Promise<{ data: Uint8Array; key: Uint8Array } | null>,
): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!cacheKey) return;
    let p = cache.get(cacheKey);
    if (!p) {
      p = load()
        .then((r) => (r ? URL.createObjectURL(new Blob([decryptWithKey(r.key, r.data) as Uint8Array<ArrayBuffer>], { type: "image/jpeg" })) : null))
        .catch(() => null);
      cache.set(cacheKey, p);
    }
    let live = true;
    p.then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
    // `load` is a fresh closure every render; the cache key identifies the thumbnail.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey]);

  return url;
}
