/// <reference lib="webworker" />
// Runs the passphrase KDF (Argon2id, ~1 s and 64 MiB) off the main thread so the UI
// keeps animating. It hands back the raw drive key (and key blob); the page rebuilds the
// vault from them. Same-origin, in-memory only.

import init, { WasmVault } from "@/wasm/vault_crypto_wasm";

type Req =
  | { id: number; op: "create"; passphrase: string }
  | { id: number; op: "unlock"; keyBlob: Uint8Array; passphrase: string }
  | { id: number; op: "rewrap"; dek: Uint8Array; keyBlob: Uint8Array; passphrase: string };

let ready: Promise<unknown> | undefined;

self.onmessage = async (e: MessageEvent<Req>) => {
  const req = e.data;
  ready ??= init({ module_or_path: "/crypto/vault_crypto_wasm_bg.wasm" });
  let vault: WasmVault | undefined;
  try {
    await ready;
    if (req.op === "create") vault = WasmVault.create(req.passphrase);
    else if (req.op === "unlock") vault = WasmVault.unlock(req.keyBlob, req.passphrase);
    else {
      vault = WasmVault.fromExportedKey(req.dek, req.keyBlob);
      vault.changePassphrase(req.passphrase);
    }
    const dek = vault.exportKey();
    const keyBlob = vault.keyBlob;
    self.postMessage({ id: req.id, dek, keyBlob }, [dek.buffer, keyBlob.buffer]);
  } catch (err) {
    self.postMessage({ id: req.id, error: err instanceof Error ? err.message : String(err) });
  } finally {
    vault?.free();
    if (req.op === "rewrap") req.dek.fill(0);
  }
};
