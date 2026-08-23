// Share links: /s/{id}#{key}. The key (in the fragment, never sent to the server)
// decrypts a manifest with the names and per-file keys of the shared files.
//
// A password-protected link ends with ".p" (`#{key}.p`): the manifest key is then
// derived from the link key and the password, so the link alone opens nothing.

import { api } from "./api";
import { concat, decryptWithKey, encryptWithKey, fromB64, fromUtf8, randomBytes, toB64, toB64Url, utf8, type WasmVault } from "./crypto";
import { isFileMeta, openItem, SHARE_AAD, type Item } from "./meta";

export interface ManifestFile {
  id: string;
  /** Folder path inside the shared folder ("" for its top level). */
  path: string;
  name: string;
  type: string;
  size: number;
  encSize: number;
  /** base64 file key */
  key: string;
  thumbKey?: string;
}

export interface Manifest {
  v: 1;
  kind: "file" | "folder";
  name: string;
  files: ManifestFile[];
  /** Hide download buttons (a courtesy, not access control). */
  viewOnly?: boolean;
}

/** What the owner keeps about a link (sealed with the vault key). */
export interface OwnerShareMeta {
  key: string;
  name: string;
  kind: "file" | "folder";
  password?: boolean;
  viewOnly?: boolean;
}

export interface ShareOptions {
  /** Unix seconds, or null for no expiry. */
  expiresAt: number | null;
  /** Empty = no password. */
  password: string;
  viewOnly: boolean;
}

const PASSWORD_SUFFIX = ".p";
const PBKDF2_ITERATIONS = 600_000;

/** Manifest key of a password link: SHA-256(linkKey ‖ PBKDF2(password, salt = linkKey)). */
async function passwordKey(linkKey: Uint8Array, password: string): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey("raw", utf8(password), "PBKDF2", false, ["deriveBits"]);
  const stretched = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: linkKey as Uint8Array<ArrayBuffer>, iterations: PBKDF2_ITERATIONS }, base, 256),
  );
  return new Uint8Array(await crypto.subtle.digest("SHA-256", concat([linkKey, stretched])));
}

/** All files under a folder, with their paths ("Sub/Dir/"). */
export async function collectFiles(
  token: string,
  tokenId: string,
  vault: WasmVault,
  folderId: string,
  path = "",
): Promise<{ item: Item; path: string }[]> {
  const out: { item: Item; path: string }[] = [];
  for (const row of await api.list(token, tokenId, folderId)) {
    const item = openItem(vault, row);
    if (!item.meta) continue;
    if (row.kind === "folder") out.push(...(await collectFiles(token, tokenId, vault, row.id, `${path}${item.meta.name}/`)));
    else out.push({ item, path });
  }
  return out;
}

export const shareLink = (id: string, key: Uint8Array, password = false) =>
  `${window.location.origin}/s/${id}#${toB64Url(key)}${password ? PASSWORD_SUFFIX : ""}`;

/** Splits a link fragment into the key and whether a password is needed. */
export function parseFragment(fragment: string): { key: string; password: boolean } {
  const password = fragment.endsWith(PASSWORD_SUFFIX);
  return { key: password ? fragment.slice(0, -PASSWORD_SUFFIX.length) : fragment, password };
}

/** Creates a link to a file or folder. Throws "empty" for a folder without files. */
export async function createShare(token: string, tokenId: string, vault: WasmVault, target: Item, opts: ShareOptions): Promise<string> {
  const files = target.row.kind === "file" ? [{ item: target, path: "" }] : await collectFiles(token, tokenId, vault, target.row.id);
  const entries: ManifestFile[] = files.flatMap(({ item, path }) => {
    const m = item.meta;
    if (!isFileMeta(m)) return [];
    return [
      {
        id: item.row.id,
        path,
        name: m.name,
        type: m.type,
        size: m.size,
        encSize: item.row.size,
        key: toB64(vault.fileKey(fromB64(m.header))),
        ...(m.thumbHeader && { thumbKey: toB64(vault.fileKey(fromB64(m.thumbHeader))) }),
      },
    ];
  });
  if (entries.length === 0) throw new Error("empty");

  const name = target.meta?.name ?? "";
  const manifest: Manifest = { v: 1, kind: target.row.kind, name, files: entries, ...(opts.viewOnly && { viewOnly: true }) };
  const key = randomBytes(32);
  const password = opts.password.length > 0;
  const manifestKey = password ? await passwordKey(key, opts.password) : key;
  const ownerMeta: OwnerShareMeta = {
    key: toB64(key),
    name,
    kind: target.row.kind,
    ...(password && { password: true }),
    ...(opts.viewOnly && { viewOnly: true }),
  };
  const { id } = await api.createShare(token, tokenId, {
    object_ids: entries.map((e) => e.id),
    manifest: toB64(encryptWithKey(manifestKey, utf8(JSON.stringify(manifest)))),
    owner_metadata: toB64(vault.sealMetadata(utf8(JSON.stringify(ownerMeta)), SHARE_AAD)),
    expires_at: opts.expiresAt,
  });
  return shareLink(id, key, password);
}

export function openOwnerShareMeta(vault: WasmVault, sealed: string): OwnerShareMeta | null {
  try {
    return JSON.parse(fromUtf8(vault.openMetadata(fromB64(sealed), SHARE_AAD)));
  } catch {
    return null;
  }
}

/** Decrypts a manifest; throws on a wrong key or password. */
export async function openManifest(key: Uint8Array, sealed: string, password?: string): Promise<Manifest> {
  const manifestKey = password !== undefined ? await passwordKey(key, password) : key;
  return JSON.parse(fromUtf8(decryptWithKey(manifestKey, fromB64(sealed))));
}
