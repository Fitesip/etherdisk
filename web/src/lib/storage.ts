"use client";

import { useSyncExternalStore } from "react";

// localStorage as an external store: no hydration mismatch (server snapshot is null)
// and every hook using a key re-renders when it changes, in this tab or another.

const EVENT = "etherdisk:storage";

export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(cb: () => void) {
  window.addEventListener("storage", cb);
  window.addEventListener(EVENT, cb);
  return () => {
    window.removeEventListener("storage", cb);
    window.removeEventListener(EVENT, cb);
  };
}

export function useStored(key: string | null): string | null {
  return useSyncExternalStore(
    subscribe,
    () => (key ? readStored(key) : null),
    () => null,
  );
}
