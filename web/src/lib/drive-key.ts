// Making a drive the caller's own after it changed hands: the previous owner knew the
// drive key, so the new owner gets a new one for everything they add (older files keep
// the keys they were encrypted with, carried in the keyring).

import { api } from "./api";
import { toB64, type WasmVault } from "./crypto";
import { makeNewKey } from "./kdf";

/** A new drive key wrapped with `passphrase`, saved on the server. Frees nothing. */
export async function takeOver(
  token: string,
  tokenId: string,
  vault: WasmVault,
  passphrase: string,
  etag: string,
): Promise<{ vault: WasmVault; etag: string }> {
  const { vault: next, keyring } = await makeNewKey(vault, passphrase);
  try {
    const saved = await api.putKey(token, tokenId, toB64(next.keyBlob), etag, toB64(keyring));
    return { vault: next, etag: saved.etag };
  } catch (err) {
    next.free();
    throw err;
  }
}
