"use client";

// Per-item customization, all inside the encrypted metadata: stars, labels, a folder's
// color and icon. The drive's label list lives in its sealed prefs (lib/prefs).

import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";

import { useT } from "@/i18n";
import { api } from "@/lib/api";
import { FOLDER_ICON_IDS, FolderIcon } from "@/lib/drive-look";
import { PRESET_COLORS } from "@/lib/drive-style";
import { itemName, sealMeta, type FileMeta, type FolderMeta, type Item } from "@/lib/meta";
import { MAX_LABEL_NAME, MAX_LABELS, newLabelId, type DrivePrefs, type Label } from "@/lib/prefs";

import { Button, cn, Dialog, Input, Notice } from "../ui";
import { ColorField, IconField, type DriveCtx } from "./dialogs";

type Meta = FileMeta | FolderMeta;

/** Re-seals an item's metadata with some fields changed. */
export async function updateMeta(ctx: DriveCtx, item: Item, patch: Partial<Meta>) {
  if (!item.meta) return;
  const next = { ...item.meta, ...patch } as Meta;
  await api.setMetadata(ctx.token, ctx.tokenId, item.row.id, sealMeta(ctx.vault, item.row.id, next));
}

/** The labels of an item that the drive still defines, in the drive's order. */
export const itemLabels = (item: Item, labels: Label[]) => {
  const ids = new Set(item.meta?.labels ?? []);
  return labels.filter((l) => ids.has(l.id));
};

export function LabelDots({ labels, className }: { labels: Label[]; className?: string }) {
  if (!labels.length) return null;
  return (
    <span className={cn("flex shrink-0 items-center -space-x-1", className)} title={labels.map((l) => l.name).join(", ")}>
      {labels.slice(0, 4).map((l) => (
        <span key={l.id} className="h-2.5 w-2.5 rounded-full ring-2 ring-card" style={{ background: l.color }} />
      ))}
    </span>
  );
}

export function LabelChip({ label, active, onClick }: { label: Label; active?: boolean; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition",
        active ? "border-transparent text-white" : "border-border text-muted hover:text-fg",
      )}
      style={active ? { background: label.color } : undefined}
    >
      {!active && <span className="h-2 w-2 rounded-full" style={{ background: label.color }} />}
      {label.name}
    </button>
  );
}

/** A folder's color and icon. */
export function FolderLookDialog({ item, onClose, ctx, onSaved }: { item: Item | null; onClose: () => void; ctx: DriveCtx; onSaved: () => void }) {
  const t = useT();
  const meta = item?.meta as FolderMeta | null | undefined;
  return (
    <Dialog open={!!item} onClose={onClose} title={t("custom.folderTitle", { name: item ? itemName(item) : "" })}>
      {item && meta && <FolderLookForm key={item.row.id} item={item} meta={meta} ctx={ctx} onDone={() => (onSaved(), onClose())} />}
    </Dialog>
  );
}

function FolderLookForm({ item, meta, ctx, onDone }: { item: Item; meta: FolderMeta; ctx: DriveCtx; onDone: () => void }) {
  const t = useT();
  const [color, setColor] = useState<string | null>(meta.color ?? null);
  const [icon, setIcon] = useState<string | null>(meta.icon ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(false);
    try {
      await updateMeta(ctx, item, { color: color ?? undefined, icon: icon ?? undefined });
      onDone();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <div className="flex items-center gap-3 rounded-lg bg-bg-subtle px-3 py-2.5">
        <FolderIcon id={icon} className="h-6 w-6" style={{ color: color ?? "var(--accent)", fill: `color-mix(in srgb, ${color ?? "var(--accent)"} 20%, transparent)` }} />
        <span className="truncate text-sm">{itemName(item)}</span>
      </div>
      <ColorField label={t("custom.color")} value={color} onChange={setColor} />
      <IconField label={t("vault.icon")} ids={FOLDER_ICON_IDS} icon={FolderIcon} value={icon} onChange={setIcon} />
      {error && <Notice tone="danger">{t("common.error")}</Notice>}
      <div className="flex justify-end">
        <Button type="submit" variant="primary" loading={busy}>
          {t("common.save")}
        </Button>
      </div>
    </form>
  );
}

/**
 * Labels for one or more items: tick the ones they should have; also create, rename,
 * recolor and delete the drive's labels.
 */
export function LabelsDialog({
  items,
  onClose,
  ctx,
  prefs,
  savePrefs,
  onSaved,
}: {
  items: Item[] | null;
  onClose: () => void;
  ctx: DriveCtx;
  prefs: DrivePrefs;
  savePrefs: (p: DrivePrefs) => Promise<void>;
  onSaved: () => void;
}) {
  const t = useT();
  return (
    <Dialog open={!!items} onClose={onClose} title={items?.length === 1 ? t("custom.labelsTitle", { name: itemName(items[0]) }) : t("custom.labelsTitleMany", { n: items?.length ?? 0 })}>
      {items && <LabelsForm key={items.map((i) => i.row.id).join()} items={items} ctx={ctx} prefs={prefs} savePrefs={savePrefs} onDone={() => (onSaved(), onClose())} />}
    </Dialog>
  );
}

function LabelsForm({
  items,
  ctx,
  prefs,
  savePrefs,
  onDone,
}: {
  items: Item[];
  ctx: DriveCtx;
  prefs: DrivePrefs;
  savePrefs: (p: DrivePrefs) => Promise<void>;
  onDone: () => void;
}) {
  const t = useT();
  const has = (id: string) => items.filter((i) => i.meta?.labels?.includes(id)).length;
  // Ticked: on every item. Mixed: on some (left as is unless clicked).
  const [checked, setChecked] = useState<Record<string, boolean | "mixed">>(() =>
    Object.fromEntries(prefs.labels.map((l) => [l.id, has(l.id) === items.length ? true : has(l.id) ? "mixed" : false])),
  );
  const [labels, setLabels] = useState(prefs.labels);
  const [editing, setEditing] = useState<Label | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  const upsert = (l: Label) => {
    setLabels((ls) => (ls.some((x) => x.id === l.id) ? ls.map((x) => (x.id === l.id ? l : x)) : [...ls, l]));
    setChecked((c) => (l.id in c ? c : { ...c, [l.id]: true }));
    setEditing(null);
  };
  const remove = (id: string) => {
    setLabels((ls) => ls.filter((x) => x.id !== id));
    setEditing(null);
  };

  async function submit() {
    setBusy(true);
    setError(false);
    try {
      if (JSON.stringify(labels) !== JSON.stringify(prefs.labels)) await savePrefs({ ...prefs, labels });
      const known = new Set(labels.map((l) => l.id));
      for (const item of items) {
        const before = item.meta?.labels ?? [];
        const after = labels
          .filter((l) => (checked[l.id] === "mixed" ? before.includes(l.id) : checked[l.id]))
          .map((l) => l.id)
          // Keep ids of labels this form doesn't know (none today; future-proof).
          .concat(before.filter((id) => !known.has(id) && prefs.labels.every((l) => l.id !== id)));
        if (after.join() !== before.join()) await updateMeta(ctx, item, { labels: after.length ? after : undefined });
      }
      onDone();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  if (editing) return <LabelEditor label={editing} isNew={!labels.some((l) => l.id === editing.id)} onSave={upsert} onDelete={() => remove(editing.id)} onCancel={() => setEditing(null)} />;

  return (
    <div className="flex flex-col gap-4">
      {labels.length ? (
        <ul className="flex flex-col gap-1">
          {labels.map((l) => {
            const state = checked[l.id] ?? false;
            return (
              <li key={l.id} className="flex items-center gap-2">
                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-bg-subtle">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-(--accent)"
                    checked={state === true}
                    ref={(el) => {
                      if (el) el.indeterminate = state === "mixed";
                    }}
                    onChange={(e) => setChecked((c) => ({ ...c, [l.id]: e.target.checked }))}
                  />
                  <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: l.color }} />
                  <span className="truncate text-sm">{l.name}</span>
                </label>
                <Button size="icon" variant="ghost" aria-label={t("custom.editLabel")} onClick={() => setEditing(l)}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-muted">{t("custom.noLabels")}</p>
      )}
      {labels.length < MAX_LABELS && (
        <Button className="self-start" onClick={() => setEditing({ id: newLabelId(), name: "", color: PRESET_COLORS[labels.length % PRESET_COLORS.length] })}>
          <Plus className="h-4 w-4" />
          {t("custom.newLabel")}
        </Button>
      )}
      <p className="text-xs text-muted">{t("custom.labelsHint")}</p>
      {error && <Notice tone="danger">{t("common.error")}</Notice>}
      <div className="flex justify-end">
        <Button variant="primary" loading={busy} onClick={submit}>
          {t("common.save")}
        </Button>
      </div>
    </div>
  );
}

function LabelEditor({ label, isNew, onSave, onDelete, onCancel }: { label: Label; isNew: boolean; onSave: (l: Label) => void; onDelete: () => void; onCancel: () => void }) {
  const t = useT();
  const [name, setName] = useState(label.name);
  const [color, setColor] = useState(label.color);
  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onSave({ ...label, name: name.trim(), color });
      }}
    >
      <label className="text-sm font-medium">
        {t("custom.labelName")}
        <Input className="mt-2 font-normal" autoFocus value={name} maxLength={MAX_LABEL_NAME} onChange={(e) => setName(e.target.value)} />
      </label>
      <ColorField label={t("custom.color")} value={color} onChange={(c) => setColor(c ?? PRESET_COLORS[0])} />
      <div className="flex flex-wrap items-center gap-2">
        {!isNew && (
          <Button variant="danger" onClick={onDelete}>
            <Trash2 className="h-4 w-4" />
            {t("custom.deleteLabel")}
          </Button>
        )}
        <span className="flex-1" />
        <Button onClick={onCancel}>{t("common.cancel")}</Button>
        <Button type="submit" variant="primary" disabled={!name.trim()}>
          {t("custom.done")}
        </Button>
      </div>
    </form>
  );
}
