"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  Download,
  File as FileIcon,
  FileText,
  Film,
  Folder,
  FolderPlus,
  Image as ImageIcon,
  KeyRound,
  Link2,
  Lock,
  MoreHorizontal,
  Move,
  Music,
  Pencil,
  Share2,
  Trash2,
  TriangleAlert,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";

import { useT } from "@/i18n";
import { api, type VaultInfo } from "@/lib/api";
import { fromB64 } from "@/lib/crypto";
import { formatBytes, formatDate, viewKind } from "@/lib/format";
import { isFileMeta, itemName, openItem, type FileMeta, type Item } from "@/lib/meta";
import { downloadFile, ownerSource, type StreamSource } from "@/lib/stream";
import { useThumbnail } from "@/lib/thumbs";
import { useUnlocked, type Unlocked } from "@/lib/unlocked";

import { Button, Card, cn, Notice, Progress, Spinner } from "../ui";
import { Viewer } from "../viewer";
import {
  ChangePassphraseDialog,
  createFolder,
  DeleteDialog,
  LinksDialog,
  MoveDialog,
  NameDialog,
  renameItem,
  ResetDialog,
  ShareDialog,
  type DriveCtx,
} from "./dialogs";
import { UploadPanel, useUploads } from "./uploads";

// ------------------------------------------------------------------ small pieces

function Menu({ trigger, children }: { trigger: ReactNode; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <div onClick={() => setOpen((o) => !o)}>{trigger}</div>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-52 rounded-lg border border-border bg-card p-1 shadow-lg">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon: Icon, label, onClick, danger }: { icon: typeof Lock; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn("flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-bg-subtle", danger && "text-danger")}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}

function TypeIcon({ meta }: { meta: Item["meta"] }) {
  if (!meta) return <TriangleAlert className="h-5 w-5 text-danger" />;
  if (!isFileMeta(meta)) return <Folder className="h-5 w-5 fill-accent/20 text-accent" />;
  const kind = viewKind(meta.name, meta.type);
  const Icon = kind === "image" ? ImageIcon : kind === "video" ? Film : kind === "audio" ? Music : kind === "text" || kind === "pdf" ? FileText : FileIcon;
  return <Icon className="h-5 w-5 text-muted" />;
}

function Thumb({ ctx, item }: { ctx: DriveCtx; item: Item }) {
  const meta = item.meta;
  const thumbHeader = isFileMeta(meta) ? meta.thumbHeader : undefined;
  const url = useThumbnail(thumbHeader && item.row.thumb_size ? `${ctx.tokenId}:${item.row.id}` : null, async () => ({
    data: await api.thumbnail(ctx.token, ctx.tokenId, item.row.id),
    key: ctx.vault.fileKey(fromB64(thumbHeader!)),
  }));
  return (
    <div className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-md bg-bg-subtle">
      {/* eslint-disable-next-line @next/next/no-img-element -- decrypted blob URL */}
      {url ? <img src={url} alt="" className="h-full w-full object-cover" /> : <TypeIcon meta={meta} />}
    </div>
  );
}

const sortItems = (items: Item[]) =>
  [...items].sort((a, b) =>
    a.row.kind !== b.row.kind ? (a.row.kind === "folder" ? -1 : 1) : itemName(a).localeCompare(itemName(b), undefined, { numeric: true }),
  );

// ------------------------------------------------------------------ browser

type Dialogs =
  | { type: "newFolder" }
  | { type: "rename"; item: Item }
  | { type: "move"; item: Item }
  | { type: "delete"; item: Item }
  | { type: "share"; item: Item }
  | { type: "links" }
  | { type: "passphrase" }
  | { type: "reset" }
  | null;

export function FileBrowser({ token, info, unlocked }: { token: string; info: VaultInfo; unlocked: Unlocked }) {
  const t = useT();
  const qc = useQueryClient();
  const store = useUnlocked();
  const tokenId = info.token_id;
  const ctx: DriveCtx = useMemo(() => ({ token, tokenId, vault: unlocked.vault }), [token, tokenId, unlocked.vault]);

  const [path, setPath] = useState<{ id: string; name: string }[]>([]);
  const current = path.at(-1)?.id ?? null;
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [viewing, setViewing] = useState<StreamSource | null>(null);
  const [dragging, setDragging] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);

  const objects = useQuery({
    queryKey: ["objects", token, tokenId, current],
    queryFn: () => api.list(token, tokenId, current),
    select: (rows) => sortItems(rows.map((r) => openItem(unlocked.vault, r))),
  });

  const refresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["objects", token, tokenId] });
    qc.invalidateQueries({ queryKey: ["vault", token, tokenId] });
  }, [qc, token, tokenId]);
  const uploads = useUploads(ctx, refresh);

  const open = (item: Item) => {
    if (item.row.kind === "folder") {
      setPath([...path, { id: item.row.id, name: itemName(item) }]);
      return;
    }
    if (!isFileMeta(item.meta)) return;
    const src = ownerSource(token, tokenId, unlocked.vault, item.row, item.meta);
    if (viewKind(item.meta.name, item.meta.type)) setViewing(src);
    else downloadFile(src);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(0);
    // Dropped folders show up as entries that are not files; skip them.
    const files = Array.from(e.dataTransfer.items)
      .filter((i) => i.kind === "file" && i.webkitGetAsEntry()?.isFile !== false)
      .map((i) => i.getAsFile())
      .filter((f): f is File => !!f);
    if (files.length) uploads.enqueue(files, current);
  };

  const close = () => setDialog(null);

  return (
    <div
      className="relative flex flex-col gap-4"
      onDragEnter={(e) => {
        e.preventDefault();
        setDragging((n) => n + 1);
      }}
      onDragLeave={() => setDragging((n) => Math.max(0, n - 1))}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      {/* Header: breadcrumbs + actions */}
      <div className="flex flex-wrap items-center gap-3">
        <nav className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-lg font-semibold tracking-tight">
          <button type="button" className={cn(path.length > 0 && "text-muted hover:text-fg")} onClick={() => setPath([])}>
            {t("files.root", { id: tokenId })}
          </button>
          {path.map((p, i) => (
            <span key={p.id} className="flex min-w-0 items-center gap-1">
              <ChevronRight className="h-4 w-4 shrink-0 text-muted" />
              <button
                type="button"
                className={cn("truncate", i < path.length - 1 && "text-muted hover:text-fg")}
                onClick={() => setPath(path.slice(0, i + 1))}
              >
                {p.name}
              </button>
            </span>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              uploads.enqueue(Array.from(e.target.files ?? []), current);
              e.target.value = "";
            }}
          />
          <Button variant="primary" onClick={() => fileInput.current?.click()}>
            <Upload className="h-4 w-4" />
            {t("files.upload")}
          </Button>
          <Button onClick={() => setDialog({ type: "newFolder" })}>
            <FolderPlus className="h-4 w-4" />
            <span className="hidden sm:inline">{t("files.newFolder")}</span>
          </Button>
          <Button onClick={() => setDialog({ type: "links" })}>
            <Link2 className="h-4 w-4" />
            <span className="hidden sm:inline">{t("files.links")}</span>
          </Button>
          <Menu
            trigger={
              <Button size="icon" variant="ghost" aria-label="Drive menu">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            }
          >
            {(closeMenu) => (
              <>
                <MenuItem icon={KeyRound} label={t("vault.changePassphrase")} onClick={() => (closeMenu(), setDialog({ type: "passphrase" }))} />
                <MenuItem icon={Lock} label={t("vault.lock")} onClick={() => store.lock(tokenId)} />
                <MenuItem icon={Trash2} label={t("vault.resetTitle")} danger onClick={() => (closeMenu(), setDialog({ type: "reset" }))} />
              </>
            )}
          </Menu>
        </div>
      </div>

      <div className="flex items-center gap-3 text-xs text-muted">
        <Progress value={info.used_bytes / info.capacity_bytes} className="max-w-48" />
        {t("drives.usage", { used: formatBytes(info.used_bytes), total: formatBytes(info.capacity_bytes) })}
      </div>

      {/* File list */}
      <Card className="overflow-hidden">
        <div className="hidden grid-cols-[1fr_7rem_11rem_2.5rem] gap-4 border-b border-border px-4 py-2 text-xs text-muted sm:grid">
          <span>{t("files.name")}</span>
          <span className="text-right">{t("files.size")}</span>
          <span>{t("files.modified")}</span>
          <span />
        </div>
        {objects.isLoading ? (
          <Spinner className="m-6" />
        ) : objects.error ? (
          <div className="p-4">
            <Notice tone="danger">{t("errors.network")}</Notice>
          </div>
        ) : !objects.data?.length ? (
          <div className="flex flex-col items-center gap-1 px-4 py-16 text-center">
            <Upload className="mb-2 h-8 w-8 text-muted" />
            <p className="font-medium">{t("files.empty")}</p>
            <p className="text-sm text-muted">{t("files.emptyHint")}</p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {objects.data.map((item) => {
              const meta = item.meta;
              return (
                <li
                  key={item.row.id}
                  className="grid grid-cols-[1fr_2.5rem] items-center gap-4 px-4 py-2 hover:bg-bg-subtle sm:grid-cols-[1fr_7rem_11rem_2.5rem]"
                >
                  <button type="button" className="flex min-w-0 items-center gap-3 text-left" onClick={() => open(item)} disabled={!meta}>
                    <Thumb ctx={ctx} item={item} />
                    <span className="truncate text-sm">{itemName(item)}</span>
                  </button>
                  <span className="hidden text-right text-sm text-muted tabular-nums sm:block">
                    {isFileMeta(meta) ? formatBytes(meta.size) : "—"}
                  </span>
                  <span className="hidden text-sm text-muted sm:block">{formatDate(item.row.updated_at)}</span>
                  <Menu
                    trigger={
                      <Button size="icon" variant="ghost" aria-label="Actions">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    }
                  >
                    {(closeMenu) => {
                      const act = (fn: () => void) => () => (closeMenu(), fn());
                      return (
                        <>
                          {item.row.kind === "file" && isFileMeta(meta) && (
                            <MenuItem
                              icon={Download}
                              label={t("files.download")}
                              onClick={act(() => downloadFile(ownerSource(token, tokenId, unlocked.vault, item.row, meta as FileMeta)))}
                            />
                          )}
                          <MenuItem icon={Share2} label={t("files.share")} onClick={act(() => setDialog({ type: "share", item }))} />
                          {meta && <MenuItem icon={Pencil} label={t("files.rename")} onClick={act(() => setDialog({ type: "rename", item }))} />}
                          <MenuItem icon={Move} label={t("files.move")} onClick={act(() => setDialog({ type: "move", item }))} />
                          <MenuItem icon={Trash2} label={t("files.delete")} danger onClick={act(() => setDialog({ type: "delete", item }))} />
                        </>
                      );
                    }}
                  </Menu>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {dragging > 0 && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center rounded-xl border-2 border-dashed border-accent bg-accent-soft/80">
          <p className="font-medium text-accent">{t("files.dropHere")}</p>
        </div>
      )}

      <UploadPanel items={uploads.items} onClear={uploads.clearFinished} />
      <Viewer source={viewing} onClose={() => setViewing(null)} />

      {dialog?.type === "newFolder" && (
        <NameDialog
          open
          onClose={close}
          ctx={ctx}
          title={t("files.newFolder")}
          submitLabel={t("files.create")}
          onSubmit={(name) => createFolder(ctx, current, name)}
        />
      )}
      {dialog?.type === "rename" && (
        <NameDialog
          open
          onClose={close}
          ctx={ctx}
          title={t("files.rename")}
          initial={itemName(dialog.item)}
          submitLabel={t("common.save")}
          onSubmit={(name) => renameItem(ctx, dialog.item, name)}
        />
      )}
      <MoveDialog item={dialog?.type === "move" ? dialog.item : null} onClose={close} ctx={ctx} />
      <DeleteDialog item={dialog?.type === "delete" ? dialog.item : null} onClose={close} ctx={ctx} />
      <ShareDialog item={dialog?.type === "share" ? dialog.item : null} onClose={close} ctx={ctx} />
      <LinksDialog open={dialog?.type === "links"} onClose={close} ctx={ctx} />
      <ChangePassphraseDialog open={dialog?.type === "passphrase"} onClose={close} ctx={ctx} etag={unlocked.etag} />
      <ResetDialog open={dialog?.type === "reset"} onClose={close} token={token} tokenId={tokenId} />
    </div>
  );
}
