"use client";

// Unlocked drives of this tab. Keys live in WASM memory and are wiped on lock, wallet
// switch, auto-lock or reload — unless the drive's "stay unlocked on reload" is on, then
// an encrypted copy is kept for this tab (see kept-keys.ts).

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import { useConnection } from "wagmi";

import { idleFor, startActivityTracking } from "./activity";
import type { WasmVault } from "./crypto";
import { forgetUnlocked, keepUnlocked, restoreUnlocked } from "./kept-keys";
import { readLockSettings } from "./lock-settings";

export interface Unlocked {
  vault: WasmVault;
  /** Etag of the key blob this vault was unlocked from (needed to change the passphrase). */
  etag: string;
}

interface Store {
  get: (tokenId: string) => Unlocked | undefined;
  set: (tokenId: string, u: Unlocked) => void;
  lock: (tokenId: string) => void;
  /** Re-applies the drive's "stay unlocked on reload" setting to the current key. */
  syncKept: (tokenId: string) => void;
  /** Tries to bring back a kept drive after a reload. Resolves to whether it did. */
  restore: (tokenId: string, currentEtag: string) => Promise<boolean>;
}

const Ctx = createContext<Store | null>(null);
const CHECK_EVERY_MS = 10_000;

/** Whether a drive kept across a reload has been idle for too long to come back. */
const idleExpired = (tokenId: string) => {
  const { idleMinutes } = readLockSettings(tokenId);
  return idleMinutes > 0 && idleFor() > idleMinutes * 60_000;
};

export function UnlockedProvider({ children }: { children: ReactNode }) {
  const { address } = useConnection();
  // The map is the source of truth (freeing WASM memory must happen exactly once,
  // so it can't live in a state updater); `version` re-renders consumers.
  const map = useRef(new Map<string, Unlocked>());
  const [version, bump] = useReducer((x: number) => x + 1, 0);

  useEffect(startActivityTracking, []);

  const syncKept = useCallback(
    (tokenId: string) => {
      const u = map.current.get(tokenId);
      if (!address || !u) return;
      if (readLockSettings(tokenId).keepOnReload) keepUnlocked(address, tokenId, u.vault, u.etag).catch(() => {});
      else forgetUnlocked(address, tokenId);
    },
    [address],
  );

  const set = useCallback(
    (tokenId: string, u: Unlocked) => {
      const prev = map.current.get(tokenId);
      if (prev && prev.vault !== u.vault) prev.vault.free();
      map.current.set(tokenId, u);
      syncKept(tokenId);
      bump();
    },
    [syncKept],
  );

  const lock = useCallback(
    (tokenId: string) => {
      map.current.get(tokenId)?.vault.free();
      map.current.delete(tokenId);
      if (address) forgetUnlocked(address, tokenId);
      bump();
    },
    [address],
  );

  const restore = useCallback(
    async (tokenId: string, currentEtag: string) => {
      if (!address || map.current.has(tokenId)) return map.current.has(tokenId);
      if (!readLockSettings(tokenId).keepOnReload || idleExpired(tokenId)) {
        forgetUnlocked(address, tokenId);
        return false;
      }
      const vault = await restoreUnlocked(address, tokenId, currentEtag);
      if (!vault) return false;
      map.current.set(tokenId, { vault, etag: currentEtag });
      bump();
      return true;
    },
    [address],
  );

  // Auto-lock: checked periodically and whenever the tab becomes visible again
  // (timers are throttled in background tabs).
  useEffect(() => {
    const check = () => {
      for (const tokenId of [...map.current.keys()]) if (idleExpired(tokenId)) lock(tokenId);
    };
    const timer = setInterval(check, CHECK_EVERY_MS);
    const onVisible = () => document.visibilityState === "visible" && check();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [lock]);

  // Another wallet must not inherit unlocked drives (kept copies are per address).
  useEffect(() => {
    const m = map.current;
    return () => {
      for (const u of m.values()) u.vault.free();
      m.clear();
      bump();
    };
  }, [address]);

  const value = useMemo(
    () => ({ get: (id: string) => map.current.get(id), set, lock, syncKept, restore }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version invalidates `get`
    [version, set, lock, syncKept, restore],
  );
  return <Ctx value={value}>{children}</Ctx>;
}

export function useUnlocked(): Store {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useUnlocked outside UnlockedProvider");
  return ctx;
}
