// Encrypted object metadata. The server sees only the sealed bytes.

import type { ObjectRow } from "./api";
import { fromB64, fromUtf8, toB64, utf8, type WasmVault } from "./crypto";

export interface FileMeta {
  v: 1;
  name: string;
  /** MIME type, restored on download. */
  type: string;
  /** Plaintext size in bytes. */
  size: number;
  /** Last-modified of the original file (ms). */
  mtime: number;
  /** base64 of the 44-byte content header: derives the file key for share links. */
  header: string;
  thumbHeader?: string;
  /** Id of the drive key the content and thumbnail are encrypted with (hex). Missing on
   *  files from before drive keys were replaced: those use the drive's first key. */
  keyId?: string;
}

export interface FolderMeta {
  v: 1;
  name: string;
}

/** Binds metadata to its object id so the server cannot swap it between objects. */
const aad = (objectId: string) => utf8(`etherdisk/object/${objectId}`);
export const SHARE_AAD = utf8("etherdisk/share");

export function sealMeta(vault: WasmVault, objectId: string, meta: FileMeta | FolderMeta): string {
  return toB64(vault.sealMetadata(utf8(JSON.stringify(meta)), aad(objectId)));
}

export interface Item {
  row: ObjectRow;
  /** null if the metadata fails to decrypt (corrupted or tampered). */
  meta: (FileMeta | FolderMeta) | null;
}

export function openItem(vault: WasmVault, row: ObjectRow): Item {
  try {
    return { row, meta: JSON.parse(fromUtf8(vault.openMetadata(fromB64(row.metadata), aad(row.id)))) };
  } catch {
    return { row, meta: null };
  }
}

export const isFileMeta = (m: Item["meta"]): m is FileMeta => !!m && "header" in m;

/** Display name, never empty. */
export const itemName = (i: Item) => i.meta?.name || "⚠ unreadable";
