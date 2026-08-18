// Turning a picked or dropped folder into files with their relative folder paths.

export interface TreeEntry {
  /** Folder path under the upload target, e.g. ["Photos", "2026"]. Empty for loose files. */
  dirs: string[];
  /** null for an empty folder (created, nothing uploaded). */
  file: File | null;
}

/** From <input webkitdirectory>: browsers fill `webkitRelativePath` ("Top/sub/file.jpg"). */
export function entriesFromInput(files: FileList | File[]): TreeEntry[] {
  return Array.from(files, (file) => ({ file, dirs: file.webkitRelativePath.split("/").slice(0, -1) }));
}

function readAll(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  // readEntries returns batches (~100) until it returns an empty one.
  return new Promise((resolve, reject) => {
    const out: FileSystemEntry[] = [];
    const next = () =>
      reader.readEntries((batch) => {
        if (!batch.length) return resolve(out);
        out.push(...batch);
        next();
      }, reject);
    next();
  });
}

const fileOf = (e: FileSystemFileEntry) => new Promise<File>((resolve, reject) => e.file(resolve, reject));

async function walk(entry: FileSystemEntry, dirs: string[], out: TreeEntry[]) {
  if (entry.isFile) {
    out.push({ dirs, file: await fileOf(entry as FileSystemFileEntry) });
    return;
  }
  if (!entry.isDirectory) return;
  const path = [...dirs, entry.name];
  const children = await readAll((entry as FileSystemDirectoryEntry).createReader());
  if (!children.length) out.push({ dirs: path, file: null });
  for (const c of children) await walk(c, path, out);
}

/**
 * From a drop. Must be called synchronously inside the drop handler: the DataTransfer
 * is emptied once the event returns, so entries are grabbed before the first await.
 */
export function entriesFromDrop(dt: DataTransfer): Promise<TreeEntry[]> {
  const roots: (FileSystemEntry | File)[] = [];
  for (const item of Array.from(dt.items)) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry?.();
    const file = entry ? null : item.getAsFile();
    if (entry) roots.push(entry);
    else if (file) roots.push(file);
  }
  return (async () => {
    const out: TreeEntry[] = [];
    for (const r of roots) {
      if (r instanceof File) out.push({ dirs: [], file: r });
      else await walk(r, [], out);
    }
    return out;
  })();
}

export const entryLabel = (e: TreeEntry) => [...e.dirs, e.file?.name ?? ""].filter(Boolean).join("/");
