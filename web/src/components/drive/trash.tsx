"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";

import { useT } from "@/i18n";
import { api } from "@/lib/api";
import { formatBytes, formatDate } from "@/lib/format";
import { isFileMeta, itemName, openItem, type Item } from "@/lib/meta";

import { useToast } from "../toast";
import { Button, Dialog, Notice, Spinner } from "../ui";
import type { DriveCtx } from "./dialogs";
import { Thumb } from "./items";

export const trashKey = (ctx: DriveCtx) => ["objects", ctx.token, ctx.tokenId, "__trash"];

function ConfirmDialog({
  open,
  title,
  text,
  confirm,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  text: string;
  confirm: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open={open} onClose={onClose} title={title} tone="danger">
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">{text}</p>
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button
            variant="danger"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onConfirm();
                onClose();
              } catch (e) {
                setError(e instanceof Error ? e.message : t("common.error"));
              } finally {
                setBusy(false);
              }
            }}
          >
            <Trash2 className="h-4 w-4" />
            {confirm}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Deleted files and folders: restore them or delete them for good. */
export function TrashView({ ctx }: { ctx: DriveCtx }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState<{ type: "one"; item: Item } | { type: "all" } | null>(null);
  const trash = useQuery({
    queryKey: trashKey(ctx),
    queryFn: () => api.trash(ctx.token, ctx.tokenId),
    select: (rows) => rows.map((r) => openItem(ctx.vault, r)),
  });

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["objects", ctx.token, ctx.tokenId] }),
      qc.invalidateQueries({ queryKey: ["path", ctx.token, ctx.tokenId] }),
      qc.invalidateQueries({ queryKey: ["vault", ctx.token, ctx.tokenId] }),
      qc.invalidateQueries({ queryKey: ["vaults", ctx.token] }),
    ]);

  async function restore(item: Item) {
    await api.restore(ctx.token, ctx.tokenId, item.row.id);
    await refresh();
    toast({ text: `${t("files.restored")}: ${itemName(item)}` });
  }

  const items = trash.data ?? [];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">{t("files.trashHint")}</p>
        {items.length > 0 && (
          <Button variant="danger" size="sm" onClick={() => setConfirm({ type: "all" })}>
            <Trash2 className="h-4 w-4" />
            {t("files.emptyTrash")}
          </Button>
        )}
      </div>
      <div className="overflow-hidden rounded-xl border border-(--drive-stroke,var(--border)) bg-card">
        {trash.isLoading ? (
          <Spinner className="m-6" />
        ) : !items.length ? (
          <div className="flex flex-col items-center gap-2 px-4 py-16 text-center">
            <Trash2 className="h-8 w-8 text-muted" />
            <p className="font-medium">{t("files.trashEmpty")}</p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((item) => (
              <li key={item.row.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <Thumb ctx={ctx} item={item} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{itemName(item)}</p>
                  <p className="text-xs text-muted">
                    {t("files.deletedAt")} {formatDate(item.row.trashed_at ?? item.row.updated_at)}
                    {isFileMeta(item.meta) && ` · ${formatBytes(item.meta.size)}`}
                  </p>
                </div>
                <Button size="sm" onClick={() => restore(item)}>
                  <RotateCcw className="h-4 w-4" />
                  {t("files.restore")}
                </Button>
                <Button size="sm" variant="ghost" className="text-danger" onClick={() => setConfirm({ type: "one", item })}>
                  {t("files.deleteForever")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={confirm?.type === "one" ? t("files.deleteForeverTitle", { name: itemName(confirm.item) }) : t("files.emptyTrashTitle")}
        text={confirm?.type === "one" ? t("files.deleteForeverText") : t("files.emptyTrashText", { n: items.length })}
        confirm={confirm?.type === "one" ? t("files.deleteForever") : t("files.emptyTrash")}
        onConfirm={async () => {
          if (confirm?.type === "one") await api.removePermanent(ctx.token, ctx.tokenId, confirm.item.row.id);
          else await api.emptyTrash(ctx.token, ctx.tokenId);
          await refresh();
        }}
      />
    </div>
  );
}
