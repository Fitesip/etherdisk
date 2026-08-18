"use client";

import { CheckCircle2, CircleAlert, Clock, Folder } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useT, type Translate } from "@/i18n";
import { ApiError } from "@/lib/api";
import { entryLabel, type TreeEntry } from "@/lib/folder-upload";
import { uploadFile } from "@/lib/upload";

import { Button, Card, Progress } from "../ui";
import { createFolder, type DriveCtx } from "./dialogs";

interface UploadItem {
  key: string;
  /** Upload batch: folders of one picked/dropped tree are created once per batch. */
  batch: string;
  parentId: string | null;
  entry: TreeEntry;
  label: string;
  progress: number;
  status: "queued" | "uploading" | "done" | "error";
  error?: string;
}

function describe(e: unknown, t: Translate): string {
  if (e instanceof ApiError) {
    if (e.status === 507) return t("files.quotaExceeded");
    if (e.status === 0) return t("errors.network");
    return e.message;
  }
  return e instanceof Error ? e.message : t("common.error");
}

/** Sequential upload queue. Uploads stop when the drive view unmounts (e.g. on lock). */
export function useUploads(ctx: DriveCtx, onUploaded: () => void) {
  const t = useT();
  const [items, setItems] = useState<UploadItem[]>([]);
  const queue = useRef<UploadItem[]>([]);
  const running = useRef(false);
  const abort = useRef<AbortController | null>(null);
  /** `${batch}/${path}` -> folder id, so each folder of a batch is created once. */
  const folders = useRef(new Map<string, string>());
  // The pump outlives renders; it reads the latest context through a ref.
  const latest = useRef({ ctx, onUploaded, t });
  useEffect(() => {
    latest.current = { ctx, onUploaded, t };
  });

  useEffect(() => {
    const c = new AbortController();
    abort.current = c;
    return () => c.abort();
  }, []);

  const update = (key: string, patch: Partial<UploadItem>) =>
    setItems((xs) => xs.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  /** Creates the missing folders of `item.entry.dirs` and returns the deepest one. */
  async function ensureFolders(ctx: DriveCtx, item: UploadItem): Promise<string | null> {
    let parent = item.parentId;
    for (let i = 0; i < item.entry.dirs.length; i++) {
      const key = `${item.batch}/${item.entry.dirs.slice(0, i + 1).join("/")}`;
      let id = folders.current.get(key);
      if (!id) {
        id = await createFolder(ctx, parent, item.entry.dirs[i]);
        folders.current.set(key, id);
      }
      parent = id;
    }
    return parent;
  }

  const pump = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      let next: UploadItem | undefined;
      while ((next = queue.current.shift()) && abort.current && !abort.current.signal.aborted) {
        const item = next;
        const { ctx, onUploaded, t } = latest.current;
        update(item.key, { status: "uploading" });
        try {
          const parentId = await ensureFolders(ctx, item);
          if (item.entry.file) {
            await uploadFile({
              ...ctx,
              parentId,
              file: item.entry.file,
              onProgress: (progress) => update(item.key, { progress }),
              signal: abort.current.signal,
            });
          }
          update(item.key, { status: "done", progress: 1 });
          onUploaded();
        } catch (e) {
          update(item.key, { status: "error", error: describe(e, t) });
        }
      }
    } finally {
      running.current = false;
    }
  }, []);

  /** Loose files and/or folder trees, uploaded into `parentId`. */
  const enqueue = useCallback(
    (entries: TreeEntry[], parentId: string | null) => {
      if (!entries.length) return;
      const batch = crypto.randomUUID();
      const added = entries.map((entry) => ({
        key: crypto.randomUUID(),
        batch,
        parentId,
        entry,
        label: entryLabel(entry),
        progress: 0,
        status: "queued" as const,
      }));
      queue.current.push(...added);
      setItems((xs) => [...xs, ...added]);
      void pump();
    },
    [pump],
  );

  const clearFinished = useCallback(() => setItems((xs) => xs.filter((x) => x.status === "queued" || x.status === "uploading")), []);

  return { items, enqueue, clearFinished };
}

export function UploadPanel({ items, onClear }: { items: UploadItem[]; onClear: () => void }) {
  const t = useT();
  if (!items.length) return null;
  const finished = items.some((i) => i.status === "done" || i.status === "error");
  const done = items.filter((i) => i.status === "done").length;
  return (
    <Card className="fixed right-4 bottom-4 z-20 w-80 shadow-xl">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <span className="text-sm font-medium">
          {t("files.uploads")} <span className="font-normal text-muted tabular-nums">{done}/{items.length}</span>
        </span>
        {finished && (
          <Button size="sm" variant="ghost" onClick={onClear}>
            {t("files.clearDone")}
          </Button>
        )}
      </div>
      <ul className="max-h-72 divide-y divide-border overflow-auto">
        {items.map((i) => (
          <li key={i.key} className="px-4 py-2.5">
            <div className="flex items-center gap-2 text-sm">
              {!i.entry.file && <Folder className="h-4 w-4 shrink-0 text-accent" />}
              <span className="min-w-0 flex-1 truncate" title={i.label}>
                {i.label}
              </span>
              {i.status === "done" && <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />}
              {i.status === "error" && <CircleAlert className="h-4 w-4 shrink-0 text-danger" />}
              {i.status === "queued" && <Clock className="h-4 w-4 shrink-0 text-muted" />}
            </div>
            {i.status === "uploading" && i.entry.file && <Progress value={i.progress} className="mt-2" />}
            {i.status === "error" && <p className="mt-1 text-xs text-danger">{i.error}</p>}
          </li>
        ))}
      </ul>
    </Card>
  );
}
