"use client";

// Files sent to the desktop app by the system (Explorer's "Upload to Etherdisk" or
// "Send to"), waiting for the user to pick a drive (and unlock it). The app keeps
// their paths; the page reads them in pieces into ordinary File objects, so they upload
// (encryption, thumbnails, folders) exactly like picked or dropped files. Empty on the site.

import { useSyncExternalStore } from "react";

import type { TreeEntry } from "./folder-upload";

/** One item as the app reports it (desktop/src-tauri/src/share.rs). */
interface SharedItem {
  id: string;
  name: string;
  size: number;
  /** Last modified, ms since the epoch. */
  modified: number;
  /** Folders under the upload target, e.g. ["Photos", "2026"]. */
  dirs: string[];
  /** An empty folder: created, nothing uploaded. */
  folder: boolean;
}

interface State {
  entries: TreeEntry[];
  /** Items still being read from disk. */
  reading: number;
  /** The drive they go to once its file browser is open (i.e. unlocked). */
  destination: string | null;
}

let state: State = { entries: [], reading: 0, destination: null };
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
const EMPTY: State = { entries: [], reading: 0, destination: null };

/** Calls `l` on every change (outside React). */
export const subscribeShared = subscribe;

export const useSharedFiles = () => useSyncExternalStore(subscribe, () => state, () => EMPTY);

export const chooseDrive = (tokenId: string) => set({ destination: tokenId });

/** The waiting files, once, if they are meant for this drive (all read from disk). */
export function takeSharedFor(tokenId: string): TreeEntry[] | null {
  if (state.destination !== tokenId || state.reading || !state.entries.length) return null;
  const { entries } = state;
  set({ entries: [], destination: null });
  return entries;
}

export const discardShared = () => set({ entries: [], destination: null });

/** Whether the page runs inside the desktop app. */
export const isDesktop = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Read in pieces: one IPC message per piece, the File stays a list of blobs. */
const PIECE = 8 << 20;

async function take() {
  const { invoke } = await import("@tauri-apps/api/core");
  const items = await invoke<SharedItem[]>("shared_files");
  if (!items.length) return;
  set({ reading: state.reading + items.length });
  const entries: TreeEntry[] = [];
  try {
    for (const item of items) {
      if (item.folder) {
        entries.push({ dirs: [...item.dirs, item.name], file: null });
      } else {
        const parts: Blob[] = [];
        for (let offset = 0; offset < item.size; offset += PIECE) {
          const len = Math.min(PIECE, item.size - offset);
          const piece = await invoke<ArrayBuffer | number[]>("read_shared", { id: item.id, offset, len });
          // Raw bytes come as an ArrayBuffer; a fallback IPC channel sends a number array.
          const bytes = piece instanceof ArrayBuffer ? new Uint8Array(piece) : Uint8Array.from(piece);
          if (bytes.length !== len) throw new Error(`${item.name}: read ${bytes.length} of ${len} bytes`);
          parts.push(new Blob([bytes]));
        }
        entries.push({ dirs: item.dirs, file: new File(parts, item.name, { lastModified: item.modified }) });
      }
      set({ reading: state.reading - 1 });
    }
  } finally {
    await invoke("forget_shared", { ids: items.map((i) => i.id) }).catch(() => {});
    set({ entries: [...state.entries, ...entries], reading: Math.max(0, state.reading - (items.length - entries.length)) });
  }
}

/** Picks up files the app was started with, and those sent while it runs. */
export function watchSharedFiles(onError: (e: unknown) => void): () => void {
  if (!isDesktop()) return () => {};
  let stop: (() => void) | undefined;
  let live = true;
  const run = () => void take().catch(onError);
  void import("@tauri-apps/api/event").then(({ listen }) =>
    listen("shared-files", run).then((unlisten) => {
      if (live) stop = unlisten;
      else unlisten();
    }),
  );
  run();
  return () => {
    live = false;
    stop?.();
  };
}
