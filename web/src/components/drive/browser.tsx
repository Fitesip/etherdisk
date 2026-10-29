"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownUp,
  ArrowLeft,
  Camera,
  ChevronRight,
  Download,
  FolderPlus,
  FolderUp,
  LayoutGrid,
  Link2,
  List,
  Lock,
  MoreHorizontal,
  Move,
  Settings,
  Star,
  Tag,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useT } from "@/i18n";
import { api, ApiError, type ObjectRow, type VaultInfo } from "@/lib/api";
import { downloadItemsZip } from "@/lib/download";
import { driveName, driveVars } from "@/lib/drive-style";
import { entriesFromDrop, entriesFromInput, type TreeEntry } from "@/lib/folder-upload";
import { formatBytes, viewKind } from "@/lib/format";
import { isFileMeta, itemName, openItem, type FileMeta, type Item } from "@/lib/meta";
import { useDrivePrefs } from "@/lib/prefs";
import { subscribeShared, takeSharedFor } from "@/lib/shared-files";
import { useStored, writeStored } from "@/lib/storage";
import { downloadFile, ownerSource } from "@/lib/stream";
import { useUnlocked, type Unlocked } from "@/lib/unlocked";

import { fullness, isShort, UsageText } from "../drive-size";
import { useToast } from "../toast";
import { Button, cn, Dialog, Notice, Progress, Spinner } from "../ui";
import { Viewer, type Gallery } from "../viewer";
import { FolderLookDialog, LabelChip, LabelsDialog, updateMeta } from "./customize";
import { createFolder, LinksDialog, MoveDialog, NameDialog, renameItem, ShareDialog, type DriveCtx } from "./dialogs";
import { ItemGrid, ItemList, Menu, MenuItem, useDropTarget, type ItemActions, type Sort, type SortKey } from "./items";
import { onOldContract } from "./move-drive";
import { ResumeBanner } from "./resume";
import { SearchBox, useSearch } from "./search";
import { RecoveryBanner } from "./recovery";
import { TrashView } from "./trash";
import { UploadPanel, useUploads } from "./uploads";

const SORT_KEY = "etherdisk.sort";
const parseSort = (raw: string | null): Sort => {
  const [key, dir] = (raw ?? "").split(":");
  return { key: key === "size" || key === "modified" ? key : "name", desc: dir === "desc" };
};
const sizeOf = (i: Item) => (isFileMeta(i.meta) ? i.meta.size : -1);

/** Starred first, then folders, then by the chosen key (name breaks ties). */
const sortItems = (items: Item[], sort: Sort) =>
  [...items].sort((a, b) => {
    if (!!a.meta?.starred !== !!b.meta?.starred) return a.meta?.starred ? -1 : 1;
    if (a.row.kind !== b.row.kind) return a.row.kind === "folder" ? -1 : 1;
    const byName = itemName(a).localeCompare(itemName(b), undefined, { numeric: true });
    const d = sort.key === "size" ? sizeOf(a) - sizeOf(b) : sort.key === "modified" ? a.row.updated_at - b.row.updated_at : byName;
    return (sort.desc ? -d : d) || byName;
  });

/** "photo.jpg" -> "photo (2).jpg", first free number. */
function uniqueName(name: string, taken: Set<string>): string {
  const dot = name.lastIndexOf(".");
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 2; ; n++) if (!taken.has(`${base} (${n})${ext}`)) return `${base} (${n})${ext}`;
}

const topName = (e: TreeEntry) => e.dirs[0] ?? e.file?.name ?? "";
const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

/** Breadcrumb that also accepts dropped items. */
function Crumb({ folderId, onDrop, className, onClick, children }: { folderId: string | null; onDrop?: (ids: string[], to: string | null) => void; className?: string; onClick: () => void; children: React.ReactNode }) {
  const drop = useDropTarget(folderId, onDrop);
  return (
    <button type="button" {...drop.props} className={cn(className, "rounded-md px-1 -mx-1", drop.over && "bg-accent-soft text-accent ring-2 ring-accent")} onClick={onClick}>
      {children}
    </button>
  );
}

interface Conflict {
  entries: TreeEntry[];
  target: string | null;
  names: string[];
}

/** Last open folder of a drive, so the Files tab returns to it. */
export const lastFolderKey = (tokenId: string) => `etherdisk.folder.${tokenId}`;
const VIEW_KEY = "etherdisk.view";

type Dialogs =
  | { type: "newFolder" }
  | { type: "rename"; item: Item }
  | { type: "move"; items: Item[] }
  | { type: "share"; item: Item }
  | { type: "links" }
  | { type: "labels"; items: Item[] }
  | { type: "folderLook"; item: Item }
  | null;

/** Show only starred items, or only those with one label. */
type Filter = "starred" | { label: string } | null;

export function FileBrowser({ token, info, unlocked }: { token: string; info: VaultInfo; unlocked: Unlocked }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const store = useUnlocked();
  const router = useRouter();
  const tokenId = info.token_id;
  const name = driveName(info, t);
  // On an earlier contract: browse, open and download only, until the drive moves.
  const readOnly = onOldContract(info);
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
  const sort = parseSort(useStored(SORT_KEY));
  const setSort = (key: SortKey) => writeStored(SORT_KEY, `${key}:${sort.key === key && !sort.desc ? "desc" : "asc"}`);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const keys = useRef<{ selectedItems: Item[]; shown: Item[]; actions: ItemActions | null; toggleAll: () => void }>({
    selectedItems: [],
    shown: [],
    actions: null,
    toggleAll: () => {},
  });
  const searchBox = useRef<HTMLDivElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>(null);
  const drivePrefs = useDrivePrefs(token, tokenId, unlocked.vault);
  const { prefs, save: savePrefs } = drivePrefs;
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [gallery, setGallery] = useState<Gallery | null>(null);
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [dragging, setDragging] = useState(false);
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
    select: (rows) => rows.map((r) => openItem(unlocked.vault, r)),
  });
  const searching = query.trim().length > 0 && !inTrash;
  const search = useSearch(ctx, searching ? query : "");
  const listed = useMemo(
    () => (searching ? search.hits.map((h) => h.item) : sortItems(objects.data ?? [], sort)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sort is derived from its two fields
    [searching, search.hits, objects.data, sort.key, sort.desc],
  );
  // A filter on a label that was deleted meanwhile shows everything.
  const activeFilter = filter && filter !== "starred" && !prefs.labels.some((l) => l.id === filter.label) ? null : filter;
  const shown = useMemo(
    () =>
      !activeFilter
        ? listed
        : listed.filter((i) => (activeFilter === "starred" ? i.meta?.starred : i.meta?.labels?.includes(activeFilter.label))),
    [listed, activeFilter],
  );
  const anyStarred = listed.some((i) => i.meta?.starred);

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

  const allActions: ItemActions = {
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
    star: async (items, on) => {
      try {
        for (const i of items) if (!!i.meta?.starred !== on) await updateMeta(ctx, i, { starred: on || undefined });
      } catch {
        toast({ text: t("common.error") });
      } finally {
        refresh();
      }
    },
    labels: (items) => setDialog({ type: "labels", items }),
    customize: (item) => setDialog({ type: "folderLook", item }),
    zip: (items) => void zip(items),
    moveTo: searching
      ? undefined
      : async (ids, folderId) => {
          try {
            for (const id of ids) await api.move(token, tokenId, id, folderId);
          } catch (e) {
            toast({ text: e instanceof Error ? e.message : t("common.error") });
          } finally {
            setSelected(new Set());
            refresh();
          }
        },
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

  const actions: ItemActions = readOnly
    ? { open: allActions.open, download: allActions.download, zip: allActions.zip }
    : allActions;

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const toggleAll = () => setSelected((s) => (shown.length && shown.every((i) => s.has(i.row.id)) ? new Set() : new Set(shown.map((i) => i.row.id))));
  const selectedItems = shown.filter((i) => selected.has(i.row.id));
  useEffect(() => {
    keys.current = { selectedItems, shown, actions, toggleAll };
  });

  /** Uploads into the open folder, asking first if names are already taken there. */
  const plan = (entries: TreeEntry[], target: string | null) => {
    if (!entries.length) return;
    const taken = new Set((target === current ? (objects.data ?? []) : []).filter((i) => i.meta).map(itemName));
    const names = [...new Set(entries.map(topName))].filter((n) => taken.has(n));
    if (names.length) setConflict({ entries, target, names });
    else uploads.enqueue(entries, target);
  };

  async function resolveConflict(choice: "replace" | "keep" | "skip") {
    if (!conflict) return;
    const { entries, target, names } = conflict;
    setConflict(null);
    const clash = new Set(names);
    const existing = new Map((objects.data ?? []).filter((i) => i.meta).map((i) => [itemName(i), i]));
    const plain = entries.filter((e) => !clash.has(topName(e)));
    const clashing = entries.filter((e) => clash.has(topName(e)));
    if (choice === "skip") return uploads.enqueue(plain, target);
    if (choice === "keep") {
      const taken = new Set([...existing.keys(), ...entries.map(topName)]);
      const renamed = new Map(names.map((n) => [n, uniqueName(n, taken)]));
      const moved = clashing.map((e) =>
        e.dirs.length
          ? { ...e, dirs: [renamed.get(e.dirs[0])!, ...e.dirs.slice(1)] }
          : { ...e, file: new File([e.file!], renamed.get(e.file!.name)!, { type: e.file!.type, lastModified: e.file!.lastModified }) },
      );
      return uploads.enqueue([...plain, ...moved], target);
    }
    // Replace: same-name files go to the trash first; same-name folders are merged into.
    const merged = new Map<string, TreeEntry[]>();
    const replaced: TreeEntry[] = [];
    for (const e of clashing) {
      const old = existing.get(topName(e))!;
      if (e.dirs.length && old.row.kind === "folder") merged.set(old.row.id, [...(merged.get(old.row.id) ?? []), { ...e, dirs: e.dirs.slice(1) }]);
      else replaced.push(e);
    }
    for (const e of replaced) {
      const old = existing.get(topName(e));
      if (old) await api.remove(token, tokenId, old.row.id).catch(() => {});
    }
    if (replaced.length) refresh();
    uploads.enqueue([...plain, ...replaced], target);
    for (const [folderId, list] of merged) uploads.enqueue(list, folderId);
  }

  // Files dropped anywhere on the page go into the open folder (not only onto the list).
  const dropInto = useRef<(data: DataTransfer) => void>(() => {});
  useEffect(() => {
    dropInto.current = (data) => {
      if (inTrash || readOnly) return;
      const target = current;
      entriesFromDrop(data).then((entries) => plan(entries, target));
    };
  });

  // Desktop app: files sent from the system to this drive upload into the open folder as
  // soon as it is unlocked and listed (shared-files.tsx), or when they arrive later.
  const takeShared = useRef(() => {});
  useEffect(() => {
    takeShared.current = () => {
      if (inTrash || readOnly || !objects.data) return;
      const entries = takeSharedFor(tokenId);
      if (entries) plan(entries, current);
    };
  });
  const ready = !!objects.data;
  useEffect(() => {
    if (ready) takeShared.current();
  }, [ready]);
  useEffect(() => subscribeShared(() => takeShared.current()), []);
  useEffect(() => {
    // Only files from the computer: drags of drive items (moves) carry no "Files". The
    // overlay that shows up then covers the window, so its own dragleave means the drag
    // left the window (no counting of enters and leaves over the page's elements).
    const isFileDrag = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
    const onEnter = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      setDragging(true);
    };
    const onOver = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onDrop = (e: DragEvent) => {
      if (!isFileDrag(e) || !e.dataTransfer) return;
      e.preventDefault();
      setDragging(false);
      dropInto.current(e.dataTransfer);
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  // Keyboard: Delete, Ctrl/Cmd+A, Esc, "/" (search), F2 (rename), Enter (open).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || document.querySelector("dialog[open]") || inTrash) return;
      const writes = !!keys.current.actions?.trash;
      const { selectedItems: sel, actions: act, toggleAll: all } = keys.current;
      if (!act) return;
      if ((e.key === "Delete" || e.key === "Backspace") && sel.length && writes) {
        e.preventDefault();
        void act.trash!(sel);
      } else if (e.key.toLowerCase() === "a" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        all();
      } else if (e.key === "Escape") {
        setSelected(new Set());
      } else if (e.key === "/") {
        e.preventDefault();
        searchBox.current?.querySelector("input")?.focus();
      } else if (e.key === "F2" && sel.length === 1 && sel[0].meta && writes) {
        e.preventDefault();
        act.rename!(sel[0]);
      } else if (e.key === "Enter" && sel.length === 1) {
        e.preventDefault();
        act.open(sel[0]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inTrash]);
  const close = () => setDialog(null);

  const View = layout === "grid" ? ItemGrid : ItemList;
  const hitPath = new Map(search.hits.map((h) => [h.item.row.id, h.path]));

  return (
    <div className="relative flex flex-col gap-4">
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
              <Crumb folderId={null} onDrop={current ? actions.moveTo : undefined} className={cn("truncate", current && "text-muted hover:text-fg")} onClick={() => go(null)}>
                {t("files.allFiles")}
              </Crumb>
              {current && pathQuery.isLoading && <Spinner className="ml-2 h-4 w-4" />}
              {path.map((p, i) => (
                <span key={p.id} className="flex min-w-0 items-center gap-1">
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted" />
                  <Crumb
                    folderId={p.id}
                    onDrop={i < path.length - 1 ? actions.moveTo : undefined}
                    className={cn("truncate", i < path.length - 1 && "text-muted hover:text-fg")}
                    onClick={() => go(p.id)}
                  >
                    {p.name}
                  </Crumb>
                </span>
              ))}
            </>
          )}
        </nav>
        {!inTrash && (
          <div ref={searchBox} className="w-full sm:w-auto">
            <SearchBox value={query} onChange={setQuery} loading={search.loading} />
          </div>
        )}
      </div>

      {/* Toolbar, or the selection bar while items are selected */}
      {selected.size > 0 ? (
        <div className="flex animate-pop-in flex-wrap items-center gap-2 rounded-xl border border-accent/40 bg-accent-soft px-3 py-2">
          <Button size="icon" variant="ghost" aria-label={t("files.clearSelection")} onClick={() => setSelected(new Set())}>
            <X className="h-4 w-4" />
          </Button>
          <span className="mr-auto text-sm font-medium">{t("files.selected", { n: selected.size })}</span>
          {!readOnly && (
            <>
              <Button
                size="sm"
                aria-label={t("custom.star")}
                title={t("custom.star")}
                onClick={() => actions.star!(selectedItems, !selectedItems.every((i) => i.meta?.starred))}
              >
                <Star className="h-4 w-4" />
              </Button>
              <Button size="sm" aria-label={t("custom.labels")} title={t("custom.labels")} onClick={() => actions.labels!(selectedItems)}>
                <Tag className="h-4 w-4" />
              </Button>
            </>
          )}
          <Button size="sm" onClick={() => zip(selectedItems)}>
            <Download className="h-4 w-4" />
            <span className="hidden sm:inline">{t("files.downloadZip")}</span>
          </Button>
          {!readOnly && (
            <>
              <Button size="sm" onClick={() => setDialog({ type: "move", items: selectedItems })}>
                <Move className="h-4 w-4" />
                <span className="hidden sm:inline">{t("files.move")}</span>
              </Button>
              <Button size="sm" variant="danger" onClick={() => actions.trash!(selectedItems)}>
                <Trash2 className="h-4 w-4" />
                <span className="hidden sm:inline">{t("files.delete")}</span>
              </Button>
            </>
          )}
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
                plan(Array.from(e.target.files ?? [], (file) => ({ file, dirs: [] })), current);
                e.target.value = "";
              }}
            />
            <input
              ref={cameraInput}
              type="file"
              accept="image/*,video/*"
              capture="environment"
              hidden
              onChange={(e) => {
                plan(Array.from(e.target.files ?? [], (file) => ({ file, dirs: [] })), current);
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
                plan(entriesFromInput(e.target.files ?? []), current);
                e.target.value = "";
              }}
            />
            {!readOnly && (
              <>
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
                      {/* Phones: straight from the camera. */}
                      <div className="sm:hidden">
                        <MenuItem icon={Camera} label={t("files.takePhoto")} onClick={() => (closeMenu(), cameraInput.current?.click())} />
                      </div>
                    </>
                  )}
                </Menu>
                <Button onClick={() => setDialog({ type: "newFolder" })}>
                  <FolderPlus className="h-4 w-4" />
                  <span className="hidden sm:inline">{t("files.newFolder")}</span>
                </Button>
              </>
            )}

            <div className="ml-auto flex items-center gap-1">
              <Menu
                trigger={
                  <Button size="icon" variant="ghost" aria-label={t("files.sortBy")} title={t("files.sortBy")}>
                    <ArrowDownUp className="h-4 w-4" />
                  </Button>
                }
              >
                {(closeMenu) => (
                  <>
                    {(
                      [
                        ["name", t("files.name")],
                        ["size", t("files.size")],
                        ["modified", t("files.modified")],
                      ] as const
                    ).map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => (closeMenu(), setSort(key))}
                        className={cn("flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm hover:bg-bg-subtle", sort.key === key && "font-medium text-accent")}
                      >
                        {label}
                        {sort.key === key && <span className="text-xs">{sort.desc ? "↓" : "↑"}</span>}
                      </button>
                    ))}
                  </>
                )}
              </Menu>
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
              {!readOnly && (
                <>
                  <Button size="icon" variant="ghost" aria-label={t("files.links")} title={t("files.links")} onClick={() => setDialog({ type: "links" })}>
                    <Link2 className="h-4 w-4" />
                  </Button>
                  <Button size="icon" variant="ghost" aria-label={t("files.trash")} title={t("files.trash")} onClick={() => navigate("view=trash")}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </>
              )}
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
                  </>
                )}
              </Menu>
            </div>
          </div>
        )
      )}

      <div className="flex items-center gap-3 text-xs text-muted">
        <Progress value={fullness(info)} className="max-w-48" />
        <UsageText info={info} />
      </div>

      {!inTrash && isShort(info) && (
        <Notice tone="danger">
          {info.usable_bytes > 0
            ? t("drives.shortNotice", { usable: formatBytes(info.usable_bytes), capacity: formatBytes(info.capacity_bytes) })
            : t("drives.shortNoticeZero", { capacity: formatBytes(info.capacity_bytes) })}
        </Notice>
      )}

      {!inTrash && (prefs.labels.length > 0 || anyStarred || activeFilter) && (
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            aria-pressed={!activeFilter}
            onClick={() => setFilter(null)}
            className={cn("h-7 rounded-full border px-2.5 text-xs transition", !activeFilter ? "border-transparent bg-fg text-bg" : "border-border text-muted hover:text-fg")}
          >
            {t("custom.filterAll")}
          </button>
          <button
            type="button"
            aria-pressed={activeFilter === "starred"}
            onClick={() => setFilter(activeFilter === "starred" ? null : "starred")}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition",
              activeFilter === "starred" ? "border-transparent bg-amber-400 text-black" : "border-border text-muted hover:text-fg",
            )}
          >
            <Star className={cn("h-3 w-3", activeFilter !== "starred" && "fill-amber-400 text-amber-400")} />
            {t("custom.starred")}
          </button>
          {prefs.labels.map((l) => {
            const on = !!activeFilter && activeFilter !== "starred" && activeFilter.label === l.id;
            return <LabelChip key={l.id} label={l} active={on} onClick={() => setFilter(on ? null : { label: l.id })} />;
          })}
        </div>
      )}

      {!inTrash && !readOnly && <RecoveryBanner ctx={ctx} recoveryAt={info.recovery_at} />}
      {!inTrash && !readOnly && <ResumeBanner ctx={ctx} onResume={uploads.resume} active={uploads.started} />}

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
            activeFilter && listed.length ? (
              <div className="flex flex-col items-center gap-3 px-4 py-16 text-center">
                <p className="text-sm text-muted">{t("custom.nothingMatches")}</p>
                <Button size="sm" onClick={() => setFilter(null)}>
                  {t("custom.clearFilter")}
                </Button>
              </div>
            ) : searching ? (
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
              sort={searching ? undefined : sort}
              onSort={searching ? undefined : setSort}
              labels={prefs.labels}
            />
          )}
        </div>
      )}

      {dragging &&
        !inTrash &&
        !readOnly &&
        createPortal(
          // Over the whole window, in the drive's colors (a portal: no transformed ancestor
          // can shrink a fixed overlay to its own box). Its content ignores the pointer, so
          // dragleave fires only when the drag leaves the window (or is cancelled).
          <div
            style={driveVars(info)}
            onDragLeave={() => setDragging(false)}
            className="fixed inset-0 z-50 grid animate-fade-up place-items-center bg-bg/70 p-4 backdrop-blur-sm"
          >
            <div className="pointer-events-none grid h-full w-full place-items-center rounded-2xl border-2 border-dashed border-accent bg-accent-soft/60">
              <div className="flex flex-col items-center gap-3 text-center">
                <Upload className="h-10 w-10 text-accent" />
                <p className="text-lg font-medium text-accent">{t("files.dropHere")}</p>
                <p className="text-sm text-muted">{path.at(-1)?.name ?? t("files.allFiles")}</p>
              </div>
            </div>
          </div>,
          document.body,
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
      <Dialog open={!!conflict} onClose={() => setConflict(null)} title={t("files.conflictTitle", { n: conflict?.names.length ?? 0 })}>
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">{t("files.conflictText")}</p>
          <ul className="max-h-40 overflow-auto rounded-lg border border-border px-3 py-2 text-sm">
            {conflict?.names.map((n) => (
              <li key={n} className="truncate">
                {n}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={() => resolveConflict("skip")}>{t("files.conflictSkip")}</Button>
            <Button onClick={() => resolveConflict("keep")}>{t("files.conflictKeep")}</Button>
            <Button variant="primary" onClick={() => resolveConflict("replace")}>
              {t("files.conflictReplace")}
            </Button>
          </div>
        </div>
      </Dialog>
      <LinksDialog open={dialog?.type === "links"} onClose={close} ctx={ctx} />
      <LabelsDialog
        items={dialog?.type === "labels" ? dialog.items : null}
        onClose={close}
        ctx={ctx}
        prefs={prefs}
        prefsState={drivePrefs.ready ? "ready" : drivePrefs.failed ? "failed" : "loading"}
        onRetry={() => void drivePrefs.retry()}
        savePrefs={savePrefs}
        onSaved={() => {
          setSelected(new Set());
          refresh();
        }}
      />
      <FolderLookDialog item={dialog?.type === "folderLook" ? dialog.item : null} onClose={close} ctx={ctx} onSaved={refresh} />
    </div>
  );
}
