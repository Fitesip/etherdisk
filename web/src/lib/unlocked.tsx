"use client";

// Unlocked drives of this tab. Keys live only in WASM memory and are wiped on lock,
// wallet switch or reload; they are never persisted.

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import { useConnection } from "wagmi";

import type { WasmVault } from "./crypto";

export interface Unlocked {
  vault: WasmVault;
  /** Etag of the key blob this vault was unlocked from (needed to change the passphrase). */
  etag: string;
}

interface Store {
  get: (tokenId: string) => Unlocked | undefined;
  set: (tokenId: string, u: Unlocked) => void;
  lock: (tokenId: string) => void;
}

const Ctx = createContext<Store | null>(null);

export function UnlockedProvider({ children }: { children: ReactNode }) {
  const { address } = useConnection();
  // The map is the source of truth (freeing WASM memory must happen exactly once,
  // so it can't live in a state updater); `version` re-renders consumers.
  const map = useRef(new Map<string, Unlocked>());
  const [version, bump] = useReducer((x: number) => x + 1, 0);

  const set = useCallback((tokenId: string, u: Unlocked) => {
    const prev = map.current.get(tokenId);
    if (prev && prev.vault !== u.vault) prev.vault.free();
    map.current.set(tokenId, u);
    bump();
  }, []);

  const lock = useCallback((tokenId: string) => {
    map.current.get(tokenId)?.vault.free();
    map.current.delete(tokenId);
    bump();
  }, []);

  // Another wallet must not inherit unlocked drives.
  useEffect(() => {
    const m = map.current;
    return () => {
      for (const u of m.values()) u.vault.free();
      m.clear();
      bump();
    };
  }, [address]);

  const value = useMemo(
    () => ({ get: (id: string) => map.current.get(id), set, lock }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version invalidates `get`
    [version, set, lock],
  );
  return <Ctx value={value}>{children}</Ctx>;
}

export function useUnlocked(): Store {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useUnlocked outside UnlockedProvider");
  return ctx;
}
