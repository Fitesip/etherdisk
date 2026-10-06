// Drive-wide settings sealed with the drive key (the server keeps only the bytes): for now
// the drive's labels. Items refer to labels by id in their own encrypted metadata.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { api } from "./api";
import { fromB64, fromUtf8, toB64, utf8, type WasmVault } from "./crypto";

export interface Label {
  id: string;
  name: string;
  /** '#rrggbb' */
  color: string;
}

export interface DrivePrefs {
  v: 1;
  labels: Label[];
}

const EMPTY: DrivePrefs = { v: 1, labels: [] };
export const MAX_LABELS = 32;
export const MAX_LABEL_NAME = 32;

/** Binds the sealed bytes to this drive, so the server cannot hand in another drive's. */
const aad = (tokenId: string) => utf8(`etherdisk/prefs/${tokenId}`);

function open(vault: WasmVault, tokenId: string, blob: string | null): DrivePrefs {
  if (!blob) return EMPTY;
  try {
    const p = JSON.parse(fromUtf8(vault.openMetadata(fromB64(blob), aad(tokenId)))) as Partial<DrivePrefs>;
    return { v: 1, labels: Array.isArray(p.labels) ? p.labels : [] };
  } catch {
    // Unreadable (sealed with a key this holder doesn't have): start over rather than fail.
    return EMPTY;
  }
}

export const newLabelId = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("");

export function useDrivePrefs(token: string, tokenId: string, vault: WasmVault) {
  const qc = useQueryClient();
  const key = ["prefs", token, tokenId];
  const query = useQuery({
    queryKey: key,
    queryFn: async () => open(vault, tokenId, (await api.prefs(token, tokenId)).blob),
    staleTime: 60_000,
  });
  const save = useCallback(
    async (next: DrivePrefs) => {
      await api.setPrefs(token, tokenId, toB64(vault.sealMetadata(utf8(JSON.stringify(next)), aad(tokenId))));
      qc.setQueryData(["prefs", token, tokenId], next);
    },
    [qc, token, tokenId, vault],
  );
  return { prefs: query.data ?? EMPTY, loading: query.isLoading, save, key };
}
