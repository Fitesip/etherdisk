"use client";

import {
  ArrowDown,
  ArrowUp,
  Check,
  Download,
  File as FileIcon,
  FileText,
  Film,
  Image as ImageIcon,
  Lock,
  MoreHorizontal,
  Move,
  Music,
  Paintbrush,
  Pencil,
  Share2,
  Star,
  StarOff,
  Tag,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import { useT } from "@/i18n";
import { api } from "@/lib/api";
import { fromB64 } from "@/lib/crypto";
import { FolderIcon } from "@/lib/drive-look";
import { formatBytes, formatDate, viewKind } from "@/lib/format";
import { isFileMeta, itemName, type Item } from "@/lib/meta";
import { useThumbnail } from "@/lib/thumbs";

import { Button, cn } from "../ui";
import type { Label } from "@/lib/prefs";

import { itemLabels, LabelDots } from "./customize";
import type { DriveCtx } from "./dialogs";

// ------------------------------------------------------------------ menu

const MENU_GAP = 4;
const EDGE = 8;

/**
 * A dropdown rendered into `document.body` with fixed positioning, so lists with
 * `overflow: hidden` don't clip it. Opens upwards when there is no room below.
 */
/** Closes an open menu on a pointer press outside `inside`, Escape, a scroll outside the menu, or a resize. */
function useDismiss(open: boolean, inside: RefObject<HTMLElement | null>[], menu: RefObject<HTMLElement | null>, close: () => void) {
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });
  useEffect(() => {
    if (!open) return;
    const done = () => closeRef.current();
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!inside.some((r) => r.current?.contains(target))) done();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && done();
    // The menu is pinned to the viewport: close it rather than let it drift from its anchor.
    const onScroll = (e: Event) => !menu.current?.contains(e.target as Node) && done();
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", done);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", done);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the refs are stable
  }, [open]);
}

const MENU_CLASS = "fixed z-50 w-52 animate-pop-in rounded-lg border border-border bg-card p-1 shadow-lg";

/**
 * A dropdown rendered into `document.body` with fixed positioning, so lists with
 * `overflow: hidden` don't clip it. Opens upwards when there is no room below.
 */
export function Menu({ trigger, children, align = "right" }: { trigger: ReactNode; children: (close: () => void) => ReactNode; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; up: boolean } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !ref.current || !menu.current) return;
    const r = ref.current.getBoundingClientRect();
    const { width, height } = menu.current.getBoundingClientRect();
    const up = r.bottom + MENU_GAP + height > window.innerHeight - EDGE && r.top - MENU_GAP - height >= EDGE;
    const top = up ? r.top - MENU_GAP - height : r.bottom + MENU_GAP;
    const left = Math.min(Math.max(align === "right" ? r.right - width : r.left, EDGE), window.innerWidth - width - EDGE);
    setPos({ top, left, up });
  }, [open, align]);
  useDismiss(open, [ref, menu], menu, () => {
    setOpen(false);
    setPos(null);
  });

  return (
    <div ref={ref} className="relative">
      <div onClick={() => setOpen((o) => !o)}>{trigger}</div>
      {open &&
        createPortal(
          <div
            ref={menu}
            style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: "hidden" }}
            className={cn(
              MENU_CLASS,
              pos?.up ? (align === "right" ? "origin-bottom-right" : "origin-bottom-left") : align === "right" ? "origin-top-right" : "origin-top-left",
            )}
          >
            {children(() => setOpen(false))}
          </div>,
          document.body,
        )}
    </div>
  );
}

/** A menu opened at a point (right click): to its right and below, flipped where it doesn't fit. */
export function ContextMenu({ at, onClose, children }: { at: { x: number; y: number } | null; onClose: () => void; children: (close: () => void) => ReactNode }) {
  const menu = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; origin: string } | null>(null);
  useLayoutEffect(() => {
    if (!at || !menu.current) return;
    const { width, height } = menu.current.getBoundingClientRect();
    const left = at.x + width > window.innerWidth - EDGE;
    const up = at.y + height > window.innerHeight - EDGE;
    setPos({
      left: Math.max(EDGE, left ? at.x - width : at.x),
      top: Math.max(EDGE, up ? at.y - height : at.y),
      origin: `${up ? "bottom" : "top"} ${left ? "right" : "left"}`,
    });
  }, [at]);
  useDismiss(!!at, [menu], menu, () => {
    setPos(null);
    onClose();
  });
  if (!at) return null;
  return createPortal(
    <div
      ref={menu}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
      style={pos ? { top: pos.top, left: pos.left, transformOrigin: pos.origin } : { top: 0, left: 0, visibility: "hidden" }}
      className={MENU_CLASS}
    >
      {children(() => {
        setPos(null);
        onClose();
      })}
    </div>,
    document.body,
  );
}

export function MenuItem({ icon: Icon, label, onClick, danger }: { icon: typeof Lock; label: string; onClick: () => void; danger?: boolean }) {
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

// ------------------------------------------------------------------ icons and thumbnails

export function TypeIcon({ meta, className = "h-5 w-5" }: { meta: Item["meta"]; className?: string }) {
  if (!meta) return <TriangleAlert className={cn(className, "text-danger")} />;
  if (!isFileMeta(meta)) {
    if (!meta.color) return <FolderIcon id={meta.icon} className={cn(className, "fill-accent/20 text-accent")} />;
    return <FolderIcon id={meta.icon} className={className} style={{ color: meta.color, fill: `color-mix(in srgb, ${meta.color} 20%, transparent)` }} />;
  }
  const kind = viewKind(meta.name, meta.type);
  const Icon = kind === "image" ? ImageIcon : kind === "video" ? Film : kind === "audio" ? Music : kind === "text" || kind === "pdf" ? FileText : FileIcon;
  return <Icon className={cn(className, "text-muted")} />;
}

export function Thumb({ ctx, item, className, iconClassName }: { ctx: DriveCtx; item: Item; className?: string; iconClassName?: string }) {
  const meta = item.meta;
  const thumbHeader = isFileMeta(meta) ? meta.thumbHeader : undefined;
  const keyId = isFileMeta(meta) ? meta.keyId : undefined;
  const url = useThumbnail(thumbHeader && item.row.thumb_size ? `${ctx.tokenId}:${item.row.id}` : null, async () => ({
    data: await api.thumbnail(ctx.token, ctx.tokenId, item.row.id),
    key: ctx.vault.fileKeyFor(fromB64(thumbHeader!), keyId),
  }));
  return (
    <div className={cn("grid shrink-0 place-items-center overflow-hidden bg-bg-subtle", className ?? "h-10 w-10 rounded-md")}>
      {/* eslint-disable-next-line @next/next/no-img-element -- decrypted blob URL */}
      {url ? <img src={url} alt="" className="h-full w-full object-cover" /> : <TypeIcon meta={meta} className={iconClassName} />}
    </div>
  );
}

// ------------------------------------------------------------------ list and grid

export interface ItemActions {
  open: (item: Item) => void;
  download: (item: Item) => void;
  share: (item: Item) => void;
  rename: (item: Item) => void;
  move: (items: Item[]) => void;
  trash: (items: Item[]) => void;
  /** Stars or unstars; omit where it doesn't apply (search results keep it). */
  star?: (items: Item[], on: boolean) => void;
  labels?: (items: Item[]) => void;
  /** A folder's color and icon. */
  customize?: (item: Item) => void;
  /** Several items as one ZIP (the right-click menu of a selection). */
  zip?: (items: Item[]) => void;
  /** Drag-and-drop move; omit to disable dragging. */
  moveTo?: (ids: string[], folderId: string | null) => void;
}

export type SortKey = "name" | "size" | "modified";
export interface Sort {
  key: SortKey;
  desc: boolean;
}

/** MIME type marking drags of drive items (as opposed to files from the desktop). */
export const DRAG_TYPE = "application/x-etherdisk-items";

/** Drag source: the dragged item, or all selected items if it is one of them. */
export function dragProps(item: Item, selected: ReadonlySet<string> | undefined, enabled: boolean) {
  if (!enabled) return {};
  return {
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      const ids = selected?.has(item.row.id) ? [...selected] : [item.row.id];
      e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids));
      e.dataTransfer.effectAllowed = "move";
    },
  };
}

/** Drop target for drive items (folders, breadcrumbs). */
export function useDropTarget(folderId: string | null, onDrop: ((ids: string[], folderId: string | null) => void) | undefined) {
  const [over, setOver] = useState(false);
  if (!onDrop) return { over: false, props: {} };
  const accepts = (e: React.DragEvent) => e.dataTransfer.types.includes(DRAG_TYPE);
  return {
    over,
    props: {
      onDragOver: (e: React.DragEvent) => {
        if (!accepts(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: (e: React.DragEvent) => {
        if (!accepts(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        const ids = (JSON.parse(e.dataTransfer.getData(DRAG_TYPE) || "[]") as string[]).filter((id) => id !== folderId);
        if (ids.length) onDrop(ids, folderId);
      },
    },
  };
}

interface ViewProps {
  ctx: DriveCtx;
  items: Item[];
  actions: ItemActions;
  /** Omit to disable selection (e.g. in search results). */
  selected?: ReadonlySet<string>;
  onToggle?: (id: string) => void;
  onToggleAll?: () => void;
  /** Secondary line under the name (e.g. the folder a search hit is in). */
  subtitle?: (item: Item) => string | undefined;
  sort?: Sort;
  onSort?: (key: SortKey) => void;
  /** The drive's labels, for the dots next to names. */
  labels?: Label[];
}

/** Star and label dots after an item's name. */
function Marks({ item, labels }: { item: Item; labels?: Label[] }) {
  const own = labels ? itemLabels(item, labels) : [];
  if (!item.meta?.starred && !own.length) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {item.meta?.starred && <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />}
      <LabelDots labels={own} />
    </span>
  );
}

function SortHeader({ k, label, sort, onSort, className }: { k: SortKey; label: string; sort?: Sort; onSort?: (k: SortKey) => void; className?: string }) {
  if (!onSort) return <span className={className}>{label}</span>;
  const active = sort?.key === k;
  return (
    <button type="button" onClick={() => onSort(k)} className={cn("flex items-center gap-1 hover:text-fg", active && "text-fg", className)}>
      {label}
      {active && (sort.desc ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}
    </button>
  );
}

/** A list row; folders also accept dropped items. */
interface RowProps {
  item: Item;
  children: ReactNode;
  className: string;
  actions: ItemActions;
  selected?: ReadonlySet<string>;
  /** The selected items on screen (the right-click menu of one of them acts on all). */
  selection: Item[];
}

function ListRow({ item, children, className, actions, selected, selection }: RowProps) {
  const drop = useDropTarget(item.row.kind === "folder" ? item.row.id : null, item.row.kind === "folder" ? actions.moveTo : undefined);
  const context = useItemContextMenu(item, actions, selection);
  return (
    <li
      {...dragProps(item, selected, !!actions.moveTo && !!item.meta)}
      {...drop.props}
      onContextMenu={context.onContextMenu}
      className={cn(className, drop.over && "bg-accent-soft ring-2 ring-accent ring-inset")}
    >
      {children}
      {context.menu}
    </li>
  );
}

function GridCard({ item, children, className, actions, selected, selection }: RowProps) {
  const drop = useDropTarget(item.row.kind === "folder" ? item.row.id : null, item.row.kind === "folder" ? actions.moveTo : undefined);
  const context = useItemContextMenu(item, actions, selection);
  return (
    <li
      {...dragProps(item, selected, !!actions.moveTo && !!item.meta)}
      {...drop.props}
      onContextMenu={context.onContextMenu}
      className={cn(className, drop.over && "ring-2 ring-accent")}
    >
      {children}
      {context.menu}
    </li>
  );
}

function ItemMenu({ item, actions }: { item: Item; actions: ItemActions }) {
  return (
    <Menu
      trigger={
        <Button size="icon" variant="ghost" aria-label="Actions">
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      }
    >
      {(close) => <ItemMenuItems item={item} actions={actions} close={close} />}
    </Menu>
  );
}

function ItemMenuItems({ item, actions, close }: { item: Item; actions: ItemActions; close: () => void }) {
  const t = useT();
  const act = (fn: () => void) => () => (close(), fn());
  return (
    <>
      {item.meta && (
        <MenuItem
          icon={Download}
          label={item.row.kind === "folder" ? t("files.downloadZip") : t("files.download")}
          onClick={act(() => actions.download(item))}
        />
      )}
      <MenuItem icon={Share2} label={t("files.share")} onClick={act(() => actions.share(item))} />
      {item.meta && <MenuItem icon={Pencil} label={t("files.rename")} onClick={act(() => actions.rename(item))} />}
      {item.meta && actions.star && (
        <MenuItem
          icon={item.meta.starred ? StarOff : Star}
          label={item.meta.starred ? t("custom.unstar") : t("custom.star")}
          onClick={act(() => actions.star!([item], !item.meta!.starred))}
        />
      )}
      {item.meta && actions.labels && <MenuItem icon={Tag} label={t("custom.labels")} onClick={act(() => actions.labels!([item]))} />}
      {item.meta && item.row.kind === "folder" && actions.customize && (
        <MenuItem icon={Paintbrush} label={t("custom.folderLook")} onClick={act(() => actions.customize!(item))} />
      )}
      <MenuItem icon={Move} label={t("files.move")} onClick={act(() => actions.move([item]))} />
      <MenuItem icon={Trash2} label={t("files.delete")} danger onClick={act(() => actions.trash([item]))} />
    </>
  );
}

/** Actions on several selected items at once (as on the selection bar). */
function SelectionMenuItems({ items, actions, close }: { items: Item[]; actions: ItemActions; close: () => void }) {
  const t = useT();
  const act = (fn: () => void) => () => (close(), fn());
  const readable = items.filter((i) => i.meta);
  const allStarred = readable.length > 0 && readable.every((i) => i.meta!.starred);
  return (
    <>
      <p className="px-3 pt-1.5 pb-1 text-xs text-muted">{t("files.selected", { n: items.length })}</p>
      {actions.zip && <MenuItem icon={Download} label={t("files.downloadZip")} onClick={act(() => actions.zip!(items))} />}
      {actions.star && readable.length > 0 && (
        <MenuItem icon={allStarred ? StarOff : Star} label={allStarred ? t("custom.unstar") : t("custom.star")} onClick={act(() => actions.star!(readable, !allStarred))} />
      )}
      {actions.labels && readable.length > 0 && <MenuItem icon={Tag} label={t("custom.labels")} onClick={act(() => actions.labels!(readable))} />}
      <MenuItem icon={Move} label={t("files.move")} onClick={act(() => actions.move(items))} />
      <MenuItem icon={Trash2} label={t("files.delete")} danger onClick={act(() => actions.trash(items))} />
    </>
  );
}

/**
 * Right click on an item: the same actions as its "…" button, at the pointer. On one of
 * several selected items, the actions apply to the whole selection (like in a file manager).
 */
function useItemContextMenu(item: Item, actions: ItemActions, selection: Item[]) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const group = selection.length > 1 && selection.includes(item);
  return {
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      setAt({ x: e.clientX, y: e.clientY });
    },
    menu: (
      <ContextMenu at={at} onClose={() => setAt(null)}>
        {(close) => (group ? <SelectionMenuItems items={selection} actions={actions} close={close} /> : <ItemMenuItems item={item} actions={actions} close={close} />)}
      </ContextMenu>
    ),
  };
}

function Checkbox({ checked, onChange, label, className }: { checked: boolean; onChange: () => void; label: string; className?: string }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onChange();
      }}
      className={cn(
        "grid h-5 w-5 shrink-0 place-items-center rounded-md border transition",
        checked ? "border-accent bg-accent text-accent-fg" : "border-border bg-card hover:border-accent",
        className,
      )}
    >
      {checked && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
    </button>
  );
}

export function ItemList({ ctx, items, actions, selected, onToggle, onToggleAll, subtitle, sort, onSort, labels }: ViewProps) {
  const t = useT();
  const selecting = !!selected && selected.size > 0;
  const selection = selected ? items.filter((i) => selected.has(i.row.id)) : [];
  const allSelected = !!selected && items.length > 0 && items.every((i) => selected.has(i.row.id));
  const cols = selected ? "grid-cols-[1.25rem_1fr_2.5rem] sm:grid-cols-[1.25rem_1fr_7rem_11rem_2.5rem]" : "grid-cols-[1fr_2.5rem] sm:grid-cols-[1fr_7rem_11rem_2.5rem]";
  return (
    <>
      <div className={cn("hidden items-center gap-4 border-b border-border px-4 py-2 text-xs text-muted sm:grid", cols)}>
        {selected && <Checkbox checked={allSelected} onChange={() => onToggleAll?.()} label={t("files.selectAll")} />}
        <SortHeader k="name" label={t("files.name")} sort={sort} onSort={onSort} />
        <SortHeader k="size" label={t("files.size")} sort={sort} onSort={onSort} className="justify-end text-right" />
        <SortHeader k="modified" label={t("files.modified")} sort={sort} onSort={onSort} />
        <span />
      </div>
      <ul className="divide-y divide-border">
        {items.map((item) => {
          const meta = item.meta;
          const isSelected = !!selected?.has(item.row.id);
          const sub = subtitle?.(item);
          return (
            <ListRow
              key={item.row.id}
              item={item}
              actions={actions}
              selected={selected}
              selection={selection}
              className={cn("group grid items-center gap-4 px-4 py-2 transition-colors", cols, isSelected ? "bg-accent-soft" : "hover:bg-bg-subtle")}
            >
              {selected && (
                <Checkbox
                  checked={isSelected}
                  onChange={() => onToggle?.(item.row.id)}
                  label={t("files.selectItem", { name: itemName(item) })}
                  className={cn(!selecting && "sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100")}
                />
              )}
              <button
                type="button"
                className="flex min-w-0 items-center gap-3 text-left"
                onClick={() => (selecting ? onToggle?.(item.row.id) : actions.open(item))}
                disabled={!meta}
              >
                <Thumb ctx={ctx} item={item} />
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm">{itemName(item)}</span>
                    <Marks item={item} labels={labels} />
                  </span>
                  {sub && <span className="block truncate text-xs text-muted">{sub}</span>}
                </span>
              </button>
              <span className="hidden text-right text-sm text-muted tabular-nums sm:block">{isFileMeta(meta) ? formatBytes(meta.size) : "—"}</span>
              <span className="hidden text-sm text-muted sm:block">{formatDate(item.row.updated_at)}</span>
              <ItemMenu item={item} actions={actions} />
            </ListRow>
          );
        })}
      </ul>
    </>
  );
}

export function ItemGrid({ ctx, items, actions, selected, onToggle, subtitle, labels }: ViewProps) {
  const t = useT();
  const selecting = !!selected && selected.size > 0;
  const selection = selected ? items.filter((i) => selected.has(i.row.id)) : [];
  return (
    <ul className="grid grid-cols-2 gap-3 p-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
      {items.map((item) => {
        const meta = item.meta;
        const isSelected = !!selected?.has(item.row.id);
        const sub = subtitle?.(item);
        return (
          <GridCard
            key={item.row.id}
            item={item}
            actions={actions}
            selected={selected}
            selection={selection}
            className={cn(
              "group relative overflow-hidden rounded-xl border bg-card transition",
              isSelected ? "border-accent ring-2 ring-accent/40" : "border-border hover:-translate-y-0.5 hover:shadow-md",
            )}
          >
            <button
              type="button"
              className="block w-full text-left"
              onClick={() => (selecting ? onToggle?.(item.row.id) : actions.open(item))}
              disabled={!meta}
            >
              <Thumb ctx={ctx} item={item} className="aspect-square w-full" iconClassName="h-10 w-10" />
              <span className="block px-3 pt-2 pb-2.5">
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm">{itemName(item)}</span>
                  <Marks item={item} labels={labels} />
                </span>
                <span className="block truncate text-xs text-muted">{sub ?? (isFileMeta(meta) ? formatBytes(meta.size) : "—")}</span>
              </span>
            </button>
            {selected && (
              <Checkbox
                checked={isSelected}
                onChange={() => onToggle?.(item.row.id)}
                label={t("files.selectItem", { name: itemName(item) })}
                className={cn("absolute top-2 left-2 shadow", !selecting && !isSelected && "sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100")}
              />
            )}
            <div className="absolute top-1.5 right-1.5 rounded-md bg-card/80 backdrop-blur transition sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100">
              <ItemMenu item={item} actions={actions} />
            </div>
          </GridCard>
        );
      })}
    </ul>
  );
}
