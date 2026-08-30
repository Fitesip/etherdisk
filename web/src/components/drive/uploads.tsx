"use client";

import { CheckCircle2, ChevronDown, CircleAlert, Clock, Folder, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import { useT, type Translate } from "@/i18n";
import { touchActivity } from "@/lib/activity";
import { ApiError } from "@/lib/api";
import { entryLabel, type TreeEntry } from "@/lib/folder-upload";
import { resumeUpload, uploadFile, type ResumeTarget } from "@/lib/upload";

import { Button, Card, cn, Progress } from "../ui";
import { createFolder, type DriveCtx } from "./dialogs";

interface UploadItem {
  key: string;
  /** Upload batch: folders of one picked/dropped tree are created once per batch. */
  batch: string;
  parentId: string | null;
  entry: TreeEntry;
  /** Continue this interrupted upload instead of starting a new one. */
  resume?: ResumeTarget;
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
  if (e instanceof Error && e.message === "mismatch") return t("files.resumeMismatchShort");
  return e instanceof Error ? e.message : t("common.error");
}

/** Sequential upload queue. Uploads stop when the drive view unmounts (e.g. on lock). */
export function useUploads(ctx: DriveCtx, onUploaded: () => void) {
  const t = useT();
  const [items, setItems] = useState<UploadItem[]>([]);
  /** Server ids of uploads this tab started, so they aren't offered for resuming. */
  const [started, setStarted] = useState<ReadonlySet<string>>(new Set());
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
            const args = {
              ...ctx,
              parentId,
              file: item.entry.file,
              onProgress: (progress: number) => {
                // An upload in progress keeps the drive from auto-locking.
                touchActivity();
                update(item.key, { progress });
              },
              onStart: (id: string) => setStarted((s) => new Set(s).add(id)),
              signal: abort.current.signal,
            };
            await (item.resume ? resumeUpload(args, item.resume) : uploadFile(args));
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

  /** Continues an interrupted upload with the re-selected file. */
  const resume = useCallback(
    (file: File, target: ResumeTarget, parentId: string | null) => {
      const item: UploadItem = {
        key: crypto.randomUUID(),
        batch: crypto.randomUUID(),
        parentId,
        entry: { file, dirs: [] },
        resume: target,
        label: file.name,
        progress: target.received / target.encSize,
        status: "queued",
      };
      queue.current.push(item);
      setItems((xs) => [...xs, item]);
      setStarted((s) => new Set(s).add(target.id));
      void pump();
    },
    [pump],
  );

  const clearFinished = useCallback(() => setItems((xs) => xs.filter((x) => x.status === "queued" || x.status === "uploading")), []);

  return { items, enqueue, resume, started, clearFinished };
}

/**
 * Upload progress, pinned to the bottom-right of the window. Rendered into <body> so no
 * transformed ancestor (e.g. a page animation) can turn `fixed` into "fixed to that box".
 * `style` carries the drive's colors, which a portal would otherwise lose.
 */
export function UploadPanel({ items, onClear, style }: { items: UploadItem[]; onClear: () => void; style?: CSSProperties }) {
  const t = useT();
  const [collapsed, setCollapsed] = useState(false);
  if (!items.length || typeof document === "undefined") return null;
  const finished = items.some((i) => i.status === "done" || i.status === "error");
  const done = items.filter((i) => i.status === "done").length;
  const failed = items.filter((i) => i.status === "error").length;
  const active = items.some((i) => i.status === "uploading" || i.status === "queued");
  // Overall progress: finished files count fully, the running one by its fraction.
  const overall = items.reduce((n, i) => n + (i.status === "done" || i.status === "error" ? 1 : i.status === "uploading" ? i.progress : 0), 0) / items.length;

  return createPortal(
    <div style={style} className="fixed right-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-40 w-[min(22rem,calc(100vw-2rem))] animate-slide-in">
      <Card className="overflow-hidden shadow-2xl">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          {active ? (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-accent" />
          ) : failed ? (
            <CircleAlert className="h-4 w-4 shrink-0 text-danger" />
          ) : (
            <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
          )}
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {t("files.uploads")}{" "}
            <span className="font-normal text-muted tabular-nums">
              {done}/{items.length}
            </span>
          </span>
          {finished && !active && (
            <Button size="sm" variant="ghost" onClick={onClear}>
              {t("files.clearDone")}
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            aria-label={collapsed ? t("files.expand") : t("files.collapse")}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((c) => !c)}
          >
            <ChevronDown className={cn("h-4 w-4 transition-transform", collapsed && "rotate-180")} />
          </Button>
        </div>
        {active && <Progress value={overall} className="h-1 rounded-none" />}
        {!collapsed && (
          <ul className="max-h-72 divide-y divide-border overflow-auto">
            {items.map((i) => (
              <li key={i.key} className="px-4 py-2.5">
                <div className="flex items-center gap-2 text-sm">
                  {!i.entry.file && <Folder className="h-4 w-4 shrink-0 text-accent" />}
                  <span className="min-w-0 flex-1 truncate" title={i.label}>
                    {i.label}
                  </span>
                  {i.status === "uploading" && <span className="shrink-0 text-xs text-muted tabular-nums">{Math.round(i.progress * 100)}%</span>}
                  {i.status === "done" && <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />}
                  {i.status === "error" && <CircleAlert className="h-4 w-4 shrink-0 text-danger" />}
                  {i.status === "queued" && <Clock className="h-4 w-4 shrink-0 text-muted" />}
                </div>
                {i.status === "uploading" && i.entry.file && <Progress value={i.progress} className="mt-2" />}
                {i.status === "error" && <p className="mt-1 text-xs text-danger">{i.error}</p>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>,
    document.body,
  );
}
