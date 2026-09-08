"use client";

// Per-device lock preferences of each drive (not secret, so plain localStorage).

import { useCallback } from "react";

import { readStored, useStored, writeStored } from "./storage";

export interface LockSettings {
  /** Lock after this many minutes without activity; 0 = never. */
  idleMinutes: number;
  /** Stay unlocked across page reloads in this tab. */
  keepOnReload: boolean;
}

export const IDLE_CHOICES = [0, 5, 15, 30, 60] as const;
export const DEFAULT_LOCK: LockSettings = { idleMinutes: 15, keepOnReload: false };

const key = (tokenId: string) => `etherdisk.lock.${tokenId}`;

function parse(raw: string | null): LockSettings {
  try {
    const v = JSON.parse(raw ?? "null") as Partial<LockSettings> | null;
    if (v) {
      return {
        idleMinutes: IDLE_CHOICES.includes(v.idleMinutes as (typeof IDLE_CHOICES)[number]) ? v.idleMinutes! : DEFAULT_LOCK.idleMinutes,
        keepOnReload: v.keepOnReload === true,
      };
    }
  } catch {}
  return DEFAULT_LOCK;
}

export const readLockSettings = (tokenId: string) => parse(readStored(key(tokenId)));

export function useLockSettings(tokenId: string): [LockSettings, (patch: Partial<LockSettings>) => void] {
  const raw = useStored(key(tokenId));
  const settings = parse(raw);
  const update = useCallback(
    (patch: Partial<LockSettings>) => writeStored(key(tokenId), JSON.stringify({ ...readLockSettings(tokenId), ...patch })),
    [tokenId],
  );
  return [settings, update];
}
