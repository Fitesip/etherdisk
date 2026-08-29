// Inbox: receiving a drive's key from its previous owner.
//
// The inbox key is derived from a wallet signature over a fixed message (wallets sign
// deterministically, so signing again later gives the same key). Its public half is
// published together with a second signature that binds it to the address; senders
// check that signature themselves, so the server can't substitute its own key.

import { bytesToHex, hexToBytes, verifyMessage, type Address, type Hex } from "viem";

import { api } from "./api";
import { fromB64, inboxOpen, inboxPublicKey, inboxSeal, loadCrypto, toB64, utf8, type WasmVault } from "./crypto";

export type Sign = (message: string) => Promise<Hex>;

/** Signed to derive the inbox key. Never send this signature anywhere. */
export const INBOX_UNLOCK_MESSAGE =
  "NFT Vault: open my inbox\n\nOnly sign this on the NFT Vault site. It lets this browser open drive keys that were sent to you. It is free and sends no transaction.";

/** Signed to publish the inbox key; must match the server's `inbox_message`. */
export const inboxMessage = (address: string, key: Uint8Array) =>
  `NFT Vault inbox key\n\nPublishing this key lets people who send you a drive include its key, encrypted so only you can open it.\n\nAddress: ${address.toLowerCase()}\nKey: ${bytesToHex(key).slice(2)}`;

/** Binds a sealed key to its token, so it can't be replayed for another drive. */
const aad = (tokenId: string) => utf8(`nft-vault/handover/${tokenId}`);

/** Derives this wallet's inbox key and publishes it (two signatures). */
export async function enableInbox(token: string, address: Address, sign: Sign): Promise<void> {
  await loadCrypto();
  const pub = inboxPublicKey(hexToBytes(await sign(INBOX_UNLOCK_MESSAGE)));
  const signature = await sign(inboxMessage(address, pub));
  await api.putInbox(token, { pubkey: toB64(pub), signature });
}

/** The recipient's inbox key if they published one and the signature checks out. */
export async function verifiedInbox(address: Address, published?: { pubkey: string; signature: string } | null): Promise<Uint8Array | null> {
  const key = published === undefined ? await api.getInbox(address) : published;
  if (!key) return null;
  const pub = fromB64(key.pubkey);
  const ok = await verifyMessage({ address, message: inboxMessage(address, pub), signature: key.signature as Hex }).catch(() => false);
  return ok ? pub : null;
}

/** Seals an unlocked drive's key to a recipient inbox (base64, ready for the server). */
export function sealDriveKey(vault: WasmVault, tokenId: string, recipient: Uint8Array): string {
  const dek = vault.exportKey();
  try {
    return toB64(inboxSeal(recipient, dek, aad(tokenId)));
  } finally {
    dek.fill(0);
  }
}

/** Opens a drive key sent to this wallet. Throws if it was sealed to another inbox. */
export async function openDriveKey(sealed: string, tokenId: string, sign: Sign): Promise<Uint8Array> {
  await loadCrypto();
  const signature = hexToBytes(await sign(INBOX_UNLOCK_MESSAGE));
  return inboxOpen(signature, fromB64(sealed), aad(tokenId));
}
