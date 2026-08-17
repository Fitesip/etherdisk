"use client";

import { CheckCircle2, CircleAlert, Clock } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useT, type Translate } from "@/i18n";
import { ApiError } from "@/lib/api";
import { uploadFile } from "@/lib/upload";

import { Button, Card, Progress } from "../ui";
import type { DriveCtx } from "./dialogs";

interface UploadItem {
  key: string;
  file: File;
  parentId: string | null;
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
          await uploadFile({
            ...ctx,
            parentId: item.parentId,
            file: item.file,
            onProgress: (progress) => update(item.key, { progress }),
            signal: abort.current.signal,
          });
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

  const enqueue = useCallback(
    (files: File[], parentId: string | null) => {
      const added = files.map((file) => ({ key: crypto.randomUUID(), file, parentId, progress: 0, status: "queued" as const }));
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
  return (
    <Card className="fixed right-4 bottom-4 z-20 w-80 shadow-xl">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <span className="text-sm font-medium">{t("files.uploads")}</span>
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
              <span className="min-w-0 flex-1 truncate">{i.file.name}</span>
              {i.status === "done" && <CheckCircle2 className="h-4 w-4 text-success" />}
              {i.status === "error" && <CircleAlert className="h-4 w-4 text-danger" />}
              {i.status === "queued" && <Clock className="h-4 w-4 text-muted" />}
            </div>
            {i.status === "uploading" && <Progress value={i.progress} className="mt-2" />}
            {i.status === "error" && <p className="mt-1 text-xs text-danger">{i.error}</p>}
          </li>
        ))}
      </ul>
    </Card>
  );
}
