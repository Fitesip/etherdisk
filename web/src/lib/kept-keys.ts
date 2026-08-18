"use client";

// "Stay unlocked across reloads". The drive key is encrypted with an AES-GCM key that is
// generated non-extractable and kept in IndexedDB; only the ciphertext goes to
// sessionStorage, which belongs to this tab and is wiped when the tab closes.
// Neither store alone reveals the drive key, and the AES key can't be read out as bytes.

import { fromB64, loadCrypto, toB64, WasmVault } from "./crypto";

const DB = "nftvault";
const STORE = "tab-keys";
const TAB_KEY = "nftvault.tab";
/** Tab keys of closed tabs are useless (their sessionStorage is gone); prune them. */
const TAB_KEY_TTL_MS = 7 * 24 * 3600 * 1000;

interface KeptEntry {
  iv: string;
  ct: string;
  keyBlob: string;
  /** Server etag of `keyBlob`: a passphrase change elsewhere invalidates the entry. */
  etag: string;
}

const entryKey = (address: string, tokenId: string) => `nftvault.kept.${address.toLowerCase()}.${tokenId}`;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idb<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = run(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

async function pruneOldTabKeys() {
  const db = await openDb();
  const store = db.transaction(STORE, "readwrite").objectStore(STORE);
  store.openCursor().onsuccess = (e) => {
    const cur = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
    if (!cur) return;
    if (Date.now() - (cur.value as { created: number }).created > TAB_KEY_TTL_MS) cur.delete();
    cur.continue();
  };
}

let tabKey: Promise<CryptoKey> | undefined;

/** This tab's wrapping key, created on first use. */
function getTabKey(): Promise<CryptoKey> {
  tabKey ??= (async () => {
    let id = sessionStorage.getItem(TAB_KEY);
    if (id) {
      const rec = await idb<{ key: CryptoKey } | undefined>("readonly", (s) => s.get(id!));
      if (rec) return rec.key;
    }
    id = crypto.randomUUID();
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await idb("readwrite", (s) => s.put({ key, created: Date.now() }, id));
    sessionStorage.setItem(TAB_KEY, id);
    pruneOldTabKeys().catch(() => {});
    return key;
  })();
  tabKey.catch(() => (tabKey = undefined));
  return tabKey;
}

export async function keepUnlocked(address: string, tokenId: string, vault: WasmVault, etag: string): Promise<void> {
  const dek = vault.exportKey();
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await getTabKey(), dek as Uint8Array<ArrayBuffer>));
    const entry: KeptEntry = { iv: toB64(iv), ct: toB64(ct), keyBlob: toB64(vault.keyBlob), etag };
    sessionStorage.setItem(entryKey(address, tokenId), JSON.stringify(entry));
  } finally {
    dek.fill(0);
  }
}

export function forgetUnlocked(address: string, tokenId: string) {
  try {
    sessionStorage.removeItem(entryKey(address, tokenId));
  } catch {}
}

export function hasKept(address: string, tokenId: string): boolean {
  try {
    return sessionStorage.getItem(entryKey(address, tokenId)) !== null;
  } catch {
    return false;
  }
}

/** The kept vault if it still matches the server's key blob; otherwise forgets it. */
export async function restoreUnlocked(address: string, tokenId: string, currentEtag: string): Promise<WasmVault | null> {
  let entry: KeptEntry;
  try {
    entry = JSON.parse(sessionStorage.getItem(entryKey(address, tokenId)) ?? "null");
  } catch {
    entry = null as unknown as KeptEntry;
  }
  if (!entry || entry.etag !== currentEtag) {
    forgetUnlocked(address, tokenId);
    return null;
  }
  try {
    await loadCrypto();
    const dek = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(entry.iv) as Uint8Array<ArrayBuffer> }, await getTabKey(), fromB64(entry.ct) as Uint8Array<ArrayBuffer>),
    );
    try {
      return WasmVault.fromExportedKey(dek, fromB64(entry.keyBlob));
    } finally {
      dek.fill(0);
    }
  } catch {
    forgetUnlocked(address, tokenId);
    return null;
  }
}
