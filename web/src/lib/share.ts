// Share links: /s/{id}#{key}. The key (in the fragment, never sent to the server)
// decrypts a manifest with the names and per-file keys of the shared files.

import { api } from "./api";
import { encryptWithKey, decryptWithKey, fromB64, fromUtf8, randomBytes, toB64, toB64Url, utf8, type WasmVault } from "./crypto";
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
}

/** What the owner keeps about a link (sealed with the vault key). */
export interface OwnerShareMeta {
  key: string;
  name: string;
  kind: "file" | "folder";
}

/** All files under a folder, with their paths. */
async function collectFiles(token: string, tokenId: string, vault: WasmVault, folderId: string, path = ""): Promise<{ item: Item; path: string }[]> {
  const out: { item: Item; path: string }[] = [];
  for (const row of await api.list(token, tokenId, folderId)) {
    const item = openItem(vault, row);
    if (!item.meta) continue;
    if (row.kind === "folder") out.push(...(await collectFiles(token, tokenId, vault, row.id, `${path}${item.meta.name}/`)));
    else out.push({ item, path });
  }
  return out;
}

export const shareLink = (id: string, key: Uint8Array) => `${window.location.origin}/s/${id}#${toB64Url(key)}`;

/** Creates a link to a file or folder. Throws "empty" for a folder without files. */
export async function createShare(token: string, tokenId: string, vault: WasmVault, target: Item): Promise<string> {
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
  const manifest: Manifest = { v: 1, kind: target.row.kind, name, files: entries };
  const key = randomBytes(32);
  const ownerMeta: OwnerShareMeta = { key: toB64(key), name, kind: target.row.kind };
  const { id } = await api.createShare(token, tokenId, {
    object_ids: entries.map((e) => e.id),
    manifest: toB64(encryptWithKey(key, utf8(JSON.stringify(manifest)))),
    owner_metadata: toB64(vault.sealMetadata(utf8(JSON.stringify(ownerMeta)), SHARE_AAD)),
  });
  return shareLink(id, key);
}

export function openOwnerShareMeta(vault: WasmVault, sealed: string): OwnerShareMeta | null {
  try {
    return JSON.parse(fromUtf8(vault.openMetadata(fromB64(sealed), SHARE_AAD)));
  } catch {
    return null;
  }
}

export function openManifest(key: Uint8Array, sealed: string): Manifest {
  return JSON.parse(fromUtf8(decryptWithKey(key, fromB64(sealed))));
}
