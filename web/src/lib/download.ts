// Downloading several files or whole folders as one streamed ZIP.

import type { WasmVault } from "./crypto";
import { isFileMeta, itemName, type Item } from "./meta";
import { collectFiles } from "./share";
import { downloadZip, ownerSource, type ZipEntry } from "./stream";

/** Archive entries for files and folders (recursively), named by their path. */
export async function zipEntries(token: string, tokenId: string, vault: WasmVault, items: Item[]): Promise<ZipEntry[]> {
  const out: ZipEntry[] = [];
  for (const item of items) {
    const files = item.row.kind === "folder" ? await collectFiles(token, tokenId, vault, item.row.id, `${itemName(item)}/`) : [{ item, path: "" }];
    for (const { item: f, path } of files) {
      if (!isFileMeta(f.meta)) continue;
      out.push({ path: path + f.meta.name, size: f.meta.size, mtime: f.meta.mtime, src: ownerSource(token, tokenId, vault, f.row, f.meta) });
    }
  }
  return out;
}

/** "Photos.zip" for one folder, "Drive name.zip" for a selection. */
export async function downloadItemsZip(token: string, tokenId: string, vault: WasmVault, items: Item[], fallbackName: string) {
  const name = items.length === 1 && items[0].row.kind === "folder" ? itemName(items[0]) : fallbackName;
  await downloadZip(`${name}.zip`, await zipEntries(token, tokenId, vault, items));
}
