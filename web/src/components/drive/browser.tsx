"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRightLeft,
  ChevronRight,
  Download,
  Eraser,
  FolderPlus,
  FolderUp,
  LayoutGrid,
  Link2,
  List,
  Lock,
  MoreHorizontal,
  Move,
  Settings,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";

import { useT } from "@/i18n";
import { api, ApiError, type ObjectRow, type VaultInfo } from "@/lib/api";
import { downloadItemsZip } from "@/lib/download";
import { driveName, driveVars } from "@/lib/drive-style";
import { entriesFromDrop, entriesFromInput } from "@/lib/folder-upload";
import { formatBytes, viewKind } from "@/lib/format";
import { isFileMeta, itemName, openItem, type FileMeta, type Item } from "@/lib/meta";
import { useStored, writeStored } from "@/lib/storage";
import { downloadFile, ownerSource } from "@/lib/stream";
import { useUnlocked, type Unlocked } from "@/lib/unlocked";

import { useToast } from "../toast";
import { Button, cn, Notice, Progress, Spinner } from "../ui";
import { Viewer, type Gallery } from "../viewer";
import { createFolder, LinksDialog, MoveDialog, NameDialog, renameItem, ResetDialog, ShareDialog, type DriveCtx } from "./dialogs";
import { ItemGrid, ItemList, Menu, MenuItem, type ItemActions } from "./items";
import { ResumeBanner } from "./resume";
import { SearchBox, useSearch } from "./search";
import { TransferDialog } from "./settings";
import { TrashView } from "./trash";
import { UploadPanel, useUploads } from "./uploads";

const sortItems = (items: Item[]) =>
  [...items].sort((a, b) =>
    a.row.kind !== b.row.kind ? (a.row.kind === "folder" ? -1 : 1) : itemName(a).localeCompare(itemName(b), undefined, { numeric: true }),
  );

/** Last open folder of a drive, so the Files tab returns to it. */
export const lastFolderKey = (tokenId: string) => `nftvault.folder.${tokenId}`;
const VIEW_KEY = "nftvault.view";

type Dialogs =
  | { type: "newFolder" }
  | { type: "rename"; item: Item }
  | { type: "move"; items: Item[] }
  | { type: "share"; item: Item }
  | { type: "links" }
  | { type: "format" }
  | { type: "transfer" }
  | null;

export function FileBrowser({ token, info, unlocked }: { token: string; info: VaultInfo; unlocked: Unlocked }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const store = useUnlocked();
  const router = useRouter();
  const tokenId = info.token_id;
  const name = driveName(info, t);
  const ctx: DriveCtx = useMemo(() => ({ token, tokenId, name, vault: unlocked.vault }), [token, tokenId, name, unlocked.vault]);

  // Where we are lives in the URL (?folder=id, ?view=trash): reload and back/forward keep it.
  const pathname = usePathname();
  const params = useSearchParams();
  const current = params.get("folder");
  const inTrash = params.get("view") === "trash";
  useEffect(() => writeStored(lastFolderKey(tokenId), current), [tokenId, current]);
  const navigate = useCallback((query: string) => window.history.pushState(null, "", query ? `${pathname}?${query}` : pathname), [pathname]);
  const go = useCallback((folderId: string | null) => navigate(folderId ? `folder=${folderId}` : ""), [navigate]);

  const layout = useStored(VIEW_KEY) === "grid" ? "grid" : "list";
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [gallery, setGallery] = useState<Gallery | null>(null);
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [dragging, setDragging] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  // A new place starts with nothing selected and no search.
  const placeKey = `${current}|${inTrash}`;
  const [lastPlace, setLastPlace] = useState(placeKey);
  if (lastPlace !== placeKey) {
    setLastPlace(placeKey);
    setSelected(new Set());
    setQuery("");
  }

  // Breadcrumbs: the folder and its ancestors, decrypted.
  const pathQuery = useQuery({
    queryKey: ["path", token, tokenId, current],
    queryFn: () => api.path(token, tokenId, current!),
    enabled: !!current && !inTrash,
    retry: false,
    select: (rows) => rows.map((r) => ({ id: r.id, name: itemName(openItem(unlocked.vault, r)) })),
  });
  const path = current ? (pathQuery.data ?? []) : [];
  const missing = pathQuery.error instanceof ApiError && pathQuery.error.status === 404;

  const objects = useQuery({
    queryKey: ["objects", token, tokenId, current],
    queryFn: () => api.list(token, tokenId, current),
    enabled: !missing && !inTrash,
    select: (rows) => sortItems(rows.map((r) => openItem(unlocked.vault, r))),
  });
  const searching = query.trim().length > 0 && !inTrash;
  const search = useSearch(ctx, searching ? query : "");
  const shown = useMemo(() => (searching ? search.hits.map((h) => h.item) : (objects.data ?? [])), [searching, search.hits, objects.data]);

  const refresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["objects", token, tokenId] });
    qc.invalidateQueries({ queryKey: ["path", token, tokenId] });
    qc.invalidateQueries({ queryKey: ["vault", token, tokenId] });
  }, [qc, token, tokenId]);
  const uploads = useUploads(ctx, refresh);

  // Seed the breadcrumbs of a folder opened from the list, so they show instantly.
  const seedPath = (row: ObjectRow) => {
    const parent = current ? qc.getQueryData<ObjectRow[]>(["path", token, tokenId, current]) : [];
    if (parent) qc.setQueryData(["path", token, tokenId, row.id], [...parent, row]);
  };

  const zip = async (items: Item[]) => {
    toast({ text: t("files.preparingZip") });
    try {
      await downloadItemsZip(token, tokenId, unlocked.vault, items, name);
    } catch (e) {
      toast({ text: e instanceof Error && e.message === "no-worker" ? t("files.zipUnavailable") : t("common.error") });
    }
  };

  const actions: ItemActions = {
    open: (item) => {
      if (item.row.kind === "folder") {
        if (!searching) seedPath(item.row);
        go(item.row.id);
        return;
      }
      if (!isFileMeta(item.meta)) return;
      if (!viewKind(item.meta.name, item.meta.type)) return void downloadFile(ownerSource(token, tokenId, unlocked.vault, item.row, item.meta));
      // Gallery: every previewable file on screen, starting at this one.
      const viewable = shown.filter((i) => isFileMeta(i.meta) && viewKind(i.meta.name, i.meta.type));
      setGallery({
        sources: viewable.map((i) => ownerSource(token, tokenId, unlocked.vault, i.row, i.meta as FileMeta)),
        index: Math.max(0, viewable.indexOf(item)),
      });
    },
    download: (item) => {
      if (item.row.kind === "folder") void zip([item]);
      else if (isFileMeta(item.meta)) void downloadFile(ownerSource(token, tokenId, unlocked.vault, item.row, item.meta));
    },
    share: (item) => setDialog({ type: "share", item }),
    rename: (item) => setDialog({ type: "rename", item }),
    move: (items) => setDialog({ type: "move", items }),
    trash: async (items) => {
      try {
        for (const i of items) await api.remove(token, tokenId, i.row.id);
      } finally {
        setSelected(new Set());
        refresh();
      }
      toast({
        text: items.length === 1 ? t("files.movedToTrash", { name: itemName(items[0]) }) : t("files.movedManyToTrash", { n: items.length }),
        action: {
          label: t("files.undo"),
          onClick: async () => {
            for (const i of items) await api.restore(token, tokenId, i.row.id).catch(() => {});
            refresh();
          },
        },
      });
    },
  };

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const toggleAll = () => setSelected((s) => (shown.length && shown.every((i) => s.has(i.row.id)) ? new Set() : new Set(shown.map((i) => i.row.id))));
  const selectedItems = shown.filter((i) => selected.has(i.row.id));

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(0);
    if (inTrash) return;
    const target = current;
    entriesFromDrop(e.dataTransfer).then((entries) => uploads.enqueue(entries, target));
  };
  const close = () => setDialog(null);

  const View = layout === "grid" ? ItemGrid : ItemList;
  const hitPath = new Map(search.hits.map((h) => [h.item.row.id, h.path]));

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
      {/* Where we are + search */}
      <div className="flex flex-wrap items-center gap-3">
        <nav className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-lg font-semibold tracking-tight">
          {inTrash ? (
            <>
              <button type="button" className="flex items-center gap-1 text-muted hover:text-fg" onClick={() => go(null)}>
                <ArrowLeft className="h-4 w-4" />
                {t("files.allFiles")}
              </button>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted" />
              <span>{t("files.trash")}</span>
            </>
          ) : searching ? (
            <span className="truncate">{t("files.searchResults", { q: query.trim() })}</span>
          ) : (
            <>
              <button type="button" className={cn("truncate", current && "text-muted hover:text-fg")} onClick={() => go(null)}>
                {t("files.allFiles")}
              </button>
              {current && pathQuery.isLoading && <Spinner className="ml-2 h-4 w-4" />}
              {path.map((p, i) => (
                <span key={p.id} className="flex min-w-0 items-center gap-1">
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted" />
                  <button type="button" className={cn("truncate", i < path.length - 1 && "text-muted hover:text-fg")} onClick={() => go(p.id)}>
                    {p.name}
                  </button>
                </span>
              ))}
            </>
          )}
        </nav>
        {!inTrash && <SearchBox value={query} onChange={setQuery} loading={search.loading} />}
      </div>

      {/* Toolbar, or the selection bar while items are selected */}
      {selected.size > 0 ? (
        <div className="flex animate-pop-in flex-wrap items-center gap-2 rounded-xl border border-accent/40 bg-accent-soft px-3 py-2">
          <Button size="icon" variant="ghost" aria-label={t("files.clearSelection")} onClick={() => setSelected(new Set())}>
            <X className="h-4 w-4" />
          </Button>
          <span className="mr-auto text-sm font-medium">{t("files.selected", { n: selected.size })}</span>
          <Button size="sm" onClick={() => zip(selectedItems)}>
            <Download className="h-4 w-4" />
            <span className="hidden sm:inline">{t("files.downloadZip")}</span>
          </Button>
          <Button size="sm" onClick={() => setDialog({ type: "move", items: selectedItems })}>
            <Move className="h-4 w-4" />
            <span className="hidden sm:inline">{t("files.move")}</span>
          </Button>
          <Button size="sm" variant="danger" onClick={() => actions.trash(selectedItems)}>
            <Trash2 className="h-4 w-4" />
            <span className="hidden sm:inline">{t("files.delete")}</span>
          </Button>
        </div>
      ) : (
        !inTrash && (
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                uploads.enqueue(Array.from(e.target.files ?? [], (file) => ({ file, dirs: [] })), current);
                e.target.value = "";
              }}
            />
            <input
              ref={(el) => {
                folderInput.current = el;
                // No typed React prop for it; Chrome, Firefox and Safari all support it.
                el?.setAttribute("webkitdirectory", "");
              }}
              type="file"
              hidden
              onChange={(e) => {
                uploads.enqueue(entriesFromInput(e.target.files ?? []), current);
                e.target.value = "";
              }}
            />
            <Menu
              align="left"
              trigger={
                <Button variant="primary">
                  <Upload className="h-4 w-4" />
                  {t("files.upload")}
                </Button>
              }
            >
              {(closeMenu) => (
                <>
                  <MenuItem icon={Upload} label={t("files.uploadFiles")} onClick={() => (closeMenu(), fileInput.current?.click())} />
                  <MenuItem icon={FolderUp} label={t("files.uploadFolder")} onClick={() => (closeMenu(), folderInput.current?.click())} />
                </>
              )}
            </Menu>
            <Button onClick={() => setDialog({ type: "newFolder" })}>
              <FolderPlus className="h-4 w-4" />
              <span className="hidden sm:inline">{t("files.newFolder")}</span>
            </Button>

            <div className="ml-auto flex items-center gap-1">
              <div role="radiogroup" className="flex rounded-lg border border-border p-0.5">
                {(
                  [
                    ["list", List, t("files.listView")],
                    ["grid", LayoutGrid, t("files.gridView")],
                  ] as const
                ).map(([mode, Icon, label]) => (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={layout === mode}
                    aria-label={label}
                    title={label}
                    onClick={() => writeStored(VIEW_KEY, mode)}
                    className={cn("grid h-7 w-7 place-items-center rounded-md transition-colors", layout === mode ? "bg-accent text-accent-fg" : "text-muted hover:text-fg")}
                  >
                    <Icon className="h-4 w-4" />
                  </button>
                ))}
              </div>
              <Button size="icon" variant="ghost" aria-label={t("files.links")} title={t("files.links")} onClick={() => setDialog({ type: "links" })}>
                <Link2 className="h-4 w-4" />
              </Button>
              <Button size="icon" variant="ghost" aria-label={t("files.trash")} title={t("files.trash")} onClick={() => navigate("view=trash")}>
                <Trash2 className="h-4 w-4" />
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
                    <MenuItem icon={Lock} label={t("vault.lock")} onClick={() => store.lock(tokenId)} />
                    <MenuItem icon={Settings} label={t("driveMenu.settings")} onClick={() => (closeMenu(), router.push(`/drive/${tokenId}/settings`))} />
                    <div className="my-1 border-t border-border" role="separator" />
                    <MenuItem icon={ArrowRightLeft} label={t("driveMenu.transfer")} danger onClick={() => (closeMenu(), setDialog({ type: "transfer" }))} />
                    <MenuItem icon={Eraser} label={t("driveMenu.format")} danger onClick={() => (closeMenu(), setDialog({ type: "format" }))} />
                  </>
                )}
              </Menu>
            </div>
          </div>
        )
      )}

      <div className="flex items-center gap-3 text-xs text-muted">
        <Progress value={info.used_bytes / info.capacity_bytes} className="max-w-48" />
        {t("drives.usage", { used: formatBytes(info.used_bytes), total: formatBytes(info.capacity_bytes) })}
      </div>

      {!inTrash && <ResumeBanner ctx={ctx} onResume={uploads.resume} active={uploads.started} />}

      {missing && !inTrash && (
        <Notice tone="danger">
          {t("files.folderNotFound")}{" "}
          <button type="button" className="underline" onClick={() => go(null)}>
            {name}
          </button>
        </Notice>
      )}

      {inTrash ? (
        <TrashView ctx={ctx} />
      ) : (
        <div className="overflow-hidden rounded-xl border border-(--drive-stroke,var(--border)) bg-card">
          {missing ? null : (searching ? search.loading : objects.isLoading) ? (
            <Spinner className="m-6" />
          ) : objects.error && !searching ? (
            <div className="p-4">
              <Notice tone="danger">{t("errors.network")}</Notice>
            </div>
          ) : !shown.length ? (
            searching ? (
              <p className="px-4 py-16 text-center text-sm text-muted">{t("files.noResults")}</p>
            ) : (
              <div className="flex flex-col items-center gap-1 px-4 py-16 text-center">
                <Upload className="mb-2 h-8 w-8 text-muted" />
                <p className="font-medium">{t("files.empty")}</p>
                <p className="text-sm text-muted">{t("files.emptyHint")}</p>
              </div>
            )
          ) : (
            <View
              ctx={ctx}
              items={shown}
              actions={actions}
              selected={searching ? undefined : selected}
              onToggle={toggle}
              onToggleAll={toggleAll}
              subtitle={searching ? (i) => (hitPath.get(i.row.id) ? t("files.inFolder", { path: hitPath.get(i.row.id)! }) : name) : undefined}
            />
          )}
        </div>
      )}

      {dragging > 0 && !inTrash && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center rounded-xl border-2 border-dashed border-accent bg-accent-soft/80">
          <p className="font-medium text-accent">{t("files.dropHere")}</p>
        </div>
      )}

      <UploadPanel items={uploads.items} onClear={uploads.clearFinished} style={driveVars(info)} />
      <Viewer gallery={gallery} onIndex={(index) => setGallery((g) => g && { ...g, index })} onClose={() => setGallery(null)} />

      {dialog?.type === "newFolder" && (
        <NameDialog
          open
          onClose={close}
          ctx={ctx}
          title={t("files.newFolder")}
          submitLabel={t("files.create")}
          onSubmit={async (folderName) => void (await createFolder(ctx, current, folderName))}
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
          onSubmit={(newName) => renameItem(ctx, dialog.item, newName)}
        />
      )}
      <MoveDialog
        items={dialog?.type === "move" ? dialog.items : null}
        onClose={() => {
          close();
          setSelected(new Set());
        }}
        ctx={ctx}
      />
      <ShareDialog item={dialog?.type === "share" ? dialog.item : null} onClose={close} ctx={ctx} />
      <LinksDialog open={dialog?.type === "links"} onClose={close} ctx={ctx} />
      <TransferDialog open={dialog?.type === "transfer"} onClose={close} token={token} info={info} />
      <ResetDialog open={dialog?.type === "format"} onClose={close} token={token} tokenId={tokenId} />
    </div>
  );
}
