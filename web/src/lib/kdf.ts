// Passphrase operations (Argon2id) in a Web Worker, so the page doesn't freeze while
// unlocking. Falls back to the main thread if workers are unavailable.

import { fromB64, loadCrypto, nextFrame, WasmVault } from "./crypto";

type Op = { op: "create"; passphrase: string } | { op: "unlock"; keyBlob: Uint8Array; passphrase: string } | { op: "rewrap"; dek: Uint8Array; keyBlob: Uint8Array; passphrase: string };
interface Result {
  dek: Uint8Array;
  keyBlob: Uint8Array;
}

let worker: Worker | null | undefined;
let nextId = 0;
const pending = new Map<number, { resolve: (r: Result) => void; reject: (e: Error) => void }>();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL("../workers/kdf.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; dek?: Uint8Array; keyBlob?: Uint8Array; error?: string }>) => {
      const p = pending.get(e.data.id);
      pending.delete(e.data.id);
      if (!p) return;
      if (e.data.error !== undefined) p.reject(new Error(e.data.error));
      else p.resolve({ dek: e.data.dek!, keyBlob: e.data.keyBlob! });
    };
    worker.onerror = () => {
      // A broken worker (e.g. blocked by policy): fail what's pending, use the main thread.
      for (const p of pending.values()) p.reject(new Error("worker failed"));
      pending.clear();
      worker?.terminate();
      worker = null;
    };
  } catch {
    worker = null;
  }
  return worker;
}

async function onMainThread(op: Op): Promise<Result> {
  await loadCrypto();
  await nextFrame();
  let v: WasmVault | undefined;
  try {
    if (op.op === "create") v = WasmVault.create(op.passphrase);
    else if (op.op === "unlock") v = WasmVault.unlock(op.keyBlob, op.passphrase);
    else {
      v = WasmVault.fromExportedKey(op.dek, op.keyBlob);
      v.changePassphrase(op.passphrase);
    }
    return { dek: v.exportKey(), keyBlob: v.keyBlob };
  } finally {
    v?.free();
  }
}

async function run(op: Op): Promise<Result> {
  const w = getWorker();
  if (!w) return onMainThread(op);
  const id = ++nextId;
  return new Promise<Result>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    // Copies, so the caller's buffers stay intact.
    w.postMessage({ id, ...op });
  }).catch((e: Error) => (e.message === "worker failed" ? onMainThread(op) : Promise.reject(e)));
}

/** Builds the page-side vault and wipes the transferred key. */
async function toVault(r: Result): Promise<WasmVault> {
  await loadCrypto();
  try {
    return WasmVault.fromExportedKey(r.dek, r.keyBlob);
  } finally {
    r.dek.fill(0);
  }
}

/** New drive key wrapped with `passphrase`. */
export async function createVault(passphrase: string): Promise<WasmVault> {
  return toVault(await run({ op: "create", passphrase }));
}

/** Throws on a wrong passphrase. */
export async function unlockVault(keyBlob: Uint8Array, passphrase: string): Promise<WasmVault> {
  return toVault(await run({ op: "unlock", keyBlob, passphrase }));
}

/** Loads a drive's older keys (from the server's key response) into an unlocked vault. */
export function openKeyring(vault: WasmVault, keyring: string | null | undefined): WasmVault {
  if (keyring) vault.openKeyring(fromB64(keyring));
  return vault;
}

/** The same drive key wrapped with a new passphrase: a new vault (free the old one). */
export async function rewrapVault(vault: WasmVault, passphrase: string): Promise<WasmVault> {
  const dek = vault.exportKey();
  // Only the current key crosses to the worker; the older ones follow sealed under it.
  const ring = vault.olderKeys > 0 ? vault.sealKeyring() : null;
  try {
    const next = await toVault(await run({ op: "rewrap", dek, keyBlob: vault.keyBlob, passphrase }));
    if (ring) next.openKeyring(ring);
    return next;
  } finally {
    dek.fill(0);
  }
}

/**
 * Makes the drive the caller's own after it changed hands: a new drive key (the previous
 * owner never had it) wrapped with `passphrase`. Returns the new vault and its sealed
 * keyring for `api.putKey(..., keyring)`.
 */
export async function makeNewKey(vault: WasmVault, passphrase: string): Promise<{ vault: WasmVault; keyring: Uint8Array }> {
  const rotated = vault.rotate();
  try {
    const next = await rewrapVault(rotated, passphrase);
    return { vault: next, keyring: next.sealKeyring() };
  } finally {
    rotated.free();
  }
}
