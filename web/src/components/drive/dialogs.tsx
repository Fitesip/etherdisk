"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronRight, Copy, Folder, HardDrive, Trash2 } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";

import { useT } from "@/i18n";
import { api, ApiError, type VaultInfo } from "@/lib/api";
import { MAX_DRIVE_NAME } from "@/lib/config";
import { fromB64, nextFrame, toB64, type WasmVault } from "@/lib/crypto";
import { driveName, driveVars, PRESET_COLORS } from "@/lib/drive-style";
import { formatDate } from "@/lib/format";
import { itemName, openItem, sealMeta, type Item } from "@/lib/meta";
import { passphraseValid } from "@/lib/passphrase";
import { createShare, openOwnerShareMeta, shareLink } from "@/lib/share";
import { useUnlocked } from "@/lib/unlocked";

import { PassphraseRules } from "../passphrase-rules";
import { Button, cn, Dialog, Input, Notice, PasswordInput, Progress, Spinner } from "../ui";

export interface DriveCtx {
  token: string;
  tokenId: string;
  /** Display name of the drive (custom or "Drive #id"). */
  name: string;
  vault: WasmVault;
}

function useInvalidate(token: string, tokenId: string) {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["objects", token, tokenId] }),
      qc.invalidateQueries({ queryKey: ["path", token, tokenId] }),
      qc.invalidateQueries({ queryKey: ["vault", token, tokenId] }),
      qc.invalidateQueries({ queryKey: ["vaults", token] }),
    ]);
}

const errorText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

export function CopyButton({ text }: { text: string }) {
  const t = useT();
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      {done ? t("common.copied") : t("common.copy")}
    </Button>
  );
}

// ------------------------------------------------------------------ drive-level

export function ResetDialog({ open, onClose, token, tokenId }: { open: boolean; onClose: () => void; token: string; tokenId: string }) {
  const t = useT();
  const qc = useQueryClient();
  const unlocked = useUnlocked();
  const [word, setWord] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.reset(token, tokenId);
      unlocked.lock(tokenId);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["vault", token, tokenId] }),
        qc.invalidateQueries({ queryKey: ["key", token, tokenId] }),
        qc.invalidateQueries({ queryKey: ["vaults", token] }),
      ]);
      setWord("");
      onClose();
    } catch (err) {
      setError(errorText(err, t("common.error")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={t("vault.resetTitle")} tone="danger">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Notice tone="danger">{t("vault.resetText")}</Notice>
        <label className="text-sm">
          {t("vault.resetConfirmLabel", { word: "DELETE" })}
          <Input className="mt-2 font-mono" value={word} onChange={(e) => setWord(e.target.value)} autoComplete="off" />
        </label>
        {error && <Notice tone="danger">{error}</Notice>}
        <Button type="submit" variant="danger" loading={busy} disabled={word !== "DELETE"}>
          {t("vault.reset")}
        </Button>
      </form>
    </Dialog>
  );
}

/** New passphrase for an unlocked drive. Only the key wrapping changes; files are untouched. */
export function ChangePassphraseForm({ ctx, etag }: { ctx: DriveCtx; etag: string }) {
  const t = useT();
  const unlocked = useUnlocked();
  const [pass, setPass] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const valid = passphraseValid(pass) && pass === repeat;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await nextFrame();
      const blob = ctx.vault.changePassphrase(pass);
      const saved = await api.putKey(ctx.token, ctx.tokenId, toB64(blob), etag);
      unlocked.set(ctx.tokenId, { vault: ctx.vault, etag: saved.etag });
      setDone(true);
      setPass("");
      setRepeat("");
    } catch (err) {
      setError(errorText(err, t("common.error")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <PasswordInput autoComplete="new-password" placeholder={t("vault.newPassphrase")} value={pass} onChange={(e) => setPass(e.target.value)} />
      <PassphraseRules value={pass} />
      <PasswordInput autoComplete="new-password" placeholder={t("vault.passphraseRepeat")} value={repeat} onChange={(e) => setRepeat(e.target.value)} />
      {repeat && pass !== repeat && <p className="text-xs text-danger">{t("vault.passphraseMismatch")}</p>}
      {error && <Notice tone="danger">{error}</Notice>}
      {done && <p className="text-sm text-success">{t("vault.passphraseChanged")}</p>}
      <Button type="submit" variant="primary" loading={busy} disabled={!valid} className="self-start">
        {t("vault.changePassphrase")}
      </Button>
    </form>
  );
}

// ------------------------------------------------------------------ objects

export function NameDialog({
  open,
  onClose,
  ctx,
  title,
  initial = "",
  submitLabel,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  ctx: DriveCtx;
  title: string;
  initial?: string;
  submitLabel: string;
  onSubmit: (name: string) => Promise<void>;
}) {
  const t = useT();
  const invalidate = useInvalidate(ctx.token, ctx.tokenId);
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(trimmed);
      await invalidate();
      onClose();
    } catch (err) {
      setError(errorText(err, t("common.error")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t("files.folderName")} maxLength={255} />
        {error && <Notice tone="danger">{error}</Notice>}
        <Button type="submit" variant="primary" loading={busy} disabled={!trimmed}>
          {submitLabel}
        </Button>
      </form>
    </Dialog>
  );
}

/** Returns the new folder's id. */
export async function createFolder(ctx: DriveCtx, parentId: string | null, name: string): Promise<string> {
  const id = crypto.randomUUID();
  await api.createFolder(ctx.token, ctx.tokenId, { id, parent_id: parentId, metadata: sealMeta(ctx.vault, id, { v: 1, name }) });
  return id;
}

export async function renameItem(ctx: DriveCtx, item: Item, name: string) {
  if (!item.meta) throw new Error("unreadable metadata");
  await api.setMetadata(ctx.token, ctx.tokenId, item.row.id, sealMeta(ctx.vault, item.row.id, { ...item.meta, name }));
}

export function DeleteDialog({ item, onClose, ctx }: { item: Item | null; onClose: () => void; ctx: DriveCtx }) {
  const t = useT();
  const invalidate = useInvalidate(ctx.token, ctx.tokenId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (!item) return;
    setBusy(true);
    setError(null);
    try {
      await api.remove(ctx.token, ctx.tokenId, item.row.id);
      await invalidate();
      onClose();
    } catch (err) {
      setError(errorText(err, t("common.error")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!item} onClose={onClose} title={item ? t("files.deleteTitle", { name: itemName(item) }) : ""}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">{item?.row.kind === "folder" ? t("files.deleteFolderText") : t("files.deleteFileText")}</p>
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="danger" loading={busy} onClick={confirm}>
            <Trash2 className="h-4 w-4" />
            {t("files.delete")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Folder picker: browse folders, then move the item into the one shown. */
export function MoveDialog({ item, onClose, ctx }: { item: Item | null; onClose: () => void; ctx: DriveCtx }) {
  const t = useT();
  const invalidate = useInvalidate(ctx.token, ctx.tokenId);
  const [path, setPath] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = path.at(-1)?.id ?? null;

  const folders = useQuery({
    queryKey: ["objects", ctx.token, ctx.tokenId, current],
    queryFn: () => api.list(ctx.token, ctx.tokenId, current),
    enabled: !!item,
    select: (rows) => rows.filter((r) => r.kind === "folder" && r.id !== item?.row.id).map((r) => openItem(ctx.vault, r)),
  });

  const close = () => {
    setPath([]);
    setError(null);
    onClose();
  };

  async function move() {
    if (!item) return;
    setBusy(true);
    setError(null);
    try {
      await api.move(ctx.token, ctx.tokenId, item.row.id, current);
      await invalidate();
      close();
    } catch (err) {
      setError(errorText(err, t("common.error")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!item} onClose={close} title={item ? t("files.moveTitle", { name: itemName(item) }) : ""}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-1 text-sm">
          <button type="button" className="text-accent hover:underline" onClick={() => setPath([])}>
            {ctx.name}
          </button>
          {path.map((p, i) => (
            <span key={p.id} className="flex items-center gap-1">
              <ChevronRight className="h-3 w-3 text-muted" />
              <button type="button" className="text-accent hover:underline" onClick={() => setPath(path.slice(0, i + 1))}>
                {p.name}
              </button>
            </span>
          ))}
        </div>
        <div className="max-h-64 min-h-24 overflow-auto rounded-lg border border-border">
          {folders.isLoading ? (
            <Spinner className="m-4" />
          ) : (
            folders.data?.map((f) => (
              <button
                key={f.row.id}
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-bg-subtle"
                onClick={() => setPath([...path, { id: f.row.id, name: itemName(f) }])}
              >
                <Folder className="h-4 w-4 text-accent" />
                {itemName(f)}
              </button>
            ))
          )}
        </div>
        {error && <Notice tone="danger">{error}</Notice>}
        <Button variant="primary" loading={busy} disabled={current === (item?.row.parent_id ?? null)} onClick={move}>
          {t("files.moveHere")}
        </Button>
      </div>
    </Dialog>
  );
}

export function ShareDialog({ item, onClose, ctx }: { item: Item | null; onClose: () => void; ctx: DriveCtx }) {
  const t = useT();
  const qc = useQueryClient();
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setLink(null);
    setError(null);
    onClose();
  };

  async function create() {
    if (!item) return;
    setBusy(true);
    setError(null);
    try {
      setLink(await createShare(ctx.token, ctx.tokenId, ctx.vault, item));
      await qc.invalidateQueries({ queryKey: ["shares", ctx.token, ctx.tokenId] });
    } catch (err) {
      setError(err instanceof Error && err.message === "empty" ? t("share.emptyFolder") : errorText(err, t("common.error")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!item} onClose={close} title={item ? t("share.createTitle", { name: itemName(item) }) : ""}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">{t("share.createText")}</p>
        {item?.row.kind === "folder" && <p className="text-sm text-muted">{t("share.folderSnapshot")}</p>}
        {link ? (
          <div className="flex items-center gap-2">
            <Input readOnly value={link} onFocus={(e) => e.target.select()} className="font-mono text-xs" />
            <CopyButton text={link} />
          </div>
        ) : (
          <Button variant="primary" loading={busy} onClick={create}>
            {busy ? t("share.creating") : t("share.create")}
          </Button>
        )}
        {error && <Notice tone="danger">{error}</Notice>}
      </div>
    </Dialog>
  );
}

/** The drive's share links, with copy and revoke. */
export function LinksList({ ctx, enabled = true }: { ctx: DriveCtx; enabled?: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const shares = useQuery({
    queryKey: ["shares", ctx.token, ctx.tokenId],
    queryFn: () => api.shares(ctx.token, ctx.tokenId),
    enabled,
  });

  async function revoke(id: string) {
    await api.revokeShare(ctx.token, ctx.tokenId, id).catch((e) => {
      if (!(e instanceof ApiError && e.status === 404)) throw e;
    });
    await qc.invalidateQueries({ queryKey: ["shares", ctx.token, ctx.tokenId] });
  }

  if (shares.isLoading) return <Spinner />;
  if (!shares.data?.length) return <p className="text-sm text-muted">{t("share.noLinks")}</p>;
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {shares.data.map((s) => {
        const meta = openOwnerShareMeta(ctx.vault, s.owner_metadata);
        const link = meta ? shareLink(s.id, fromB64(meta.key)) : null;
        return (
          <li key={s.id} className="flex flex-wrap items-center gap-3 p-3">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{meta?.name ?? "⚠"}</div>
              <div className="text-xs text-muted">
                {t("share.files", { n: s.file_count })} · {formatDate(s.created_at)}
              </div>
            </div>
            {link && <CopyButton text={link} />}
            <Button size="sm" variant="ghost" className="text-danger" onClick={() => revoke(s.id)}>
              {t("share.revoke")}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

export function LinksDialog({ open, onClose, ctx }: { open: boolean; onClose: () => void; ctx: DriveCtx }) {
  const t = useT();
  return (
    <Dialog open={open} onClose={onClose} title={t("share.linksTitle", { name: ctx.name })} wide>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">{t("share.revokedOnTransfer")}</p>
        <LinksList ctx={ctx} enabled={open} />
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ drive look

const SELECTED = "ring-2 ring-fg ring-offset-2 ring-offset-card";

function ColorField({ label, value, onChange }: { label: string; value: string | null; onChange: (v: string | null) => void }) {
  const t = useT();
  const custom = value !== null && !PRESET_COLORS.includes(value);
  return (
    <fieldset>
      <legend className="text-sm font-medium">{label}</legend>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          aria-pressed={value === null}
          onClick={() => onChange(null)}
          className={cn("h-7 rounded-full border border-border px-2.5 text-xs", value === null && SELECTED)}
        >
          {t("vault.colorDefault")}
        </button>
        {PRESET_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={c}
            aria-pressed={value === c}
            onClick={() => onChange(c)}
            className={cn("h-7 w-7 rounded-full", value === c && SELECTED)}
            style={{ background: c }}
          />
        ))}
        <label
          className={cn("relative h-7 w-7 cursor-pointer overflow-hidden rounded-full border border-border", custom && SELECTED)}
          style={{ background: custom ? value : "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)" }}
          title={t("vault.colorCustom")}
        >
          <input
            type="color"
            aria-label={t("vault.colorCustom")}
            className="absolute inset-0 cursor-pointer opacity-0"
            value={value ?? "#4f46e5"}
            onChange={(e) => onChange(e.target.value)}
          />
        </label>
        {value && <span className="ml-1 font-mono text-xs text-muted">{value}</span>}
      </div>
    </fieldset>
  );
}

/** Drive card body, colored by the drive's profile (drive list and settings preview). */
export function DriveTile({ info, status, footer }: { info: VaultInfo; status?: ReactNode; footer?: ReactNode }) {
  const t = useT();
  return (
    <div
      style={driveVars(info)}
      className="flex items-center gap-4 rounded-xl border border-(--drive-stroke,var(--border)) bg-card p-4 transition"
    >
      <div className="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-accent text-accent-fg">
        <HardDrive className="h-6 w-6" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate font-medium">{driveName(info, t)}</span>
          {status}
        </div>
        <Progress value={info.used_bytes / info.capacity_bytes} className="mt-2" />
        {footer}
      </div>
    </div>
  );
}

/** Rename the drive and pick its outline and fill colors, with a live preview. */
export function DriveLookForm({ token, info }: { token: string; info: VaultInfo }) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = useState(info.name ?? "");
  const [stroke, setStroke] = useState(info.stroke);
  const [fill, setFill] = useState(info.fill);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const preview: VaultInfo = { ...info, name: name.trim() || null, stroke, fill };
  const dirty = (info.name ?? "") !== name.trim() || info.stroke !== stroke || info.fill !== fill;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const updated = await api.setProfile(token, info.token_id, { name: name.trim() || null, stroke, fill });
      qc.setQueryData(["vault", token, info.token_id], updated);
      await qc.invalidateQueries({ queryKey: ["vaults", token] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(errorText(err, t("common.error")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-6 lg:grid-cols-[1fr_18rem]">
      <div className="flex flex-col gap-5">
        <label className="text-sm font-medium">
          {t("vault.name")}
          <Input
            className="mt-2 font-normal"
            value={name}
            maxLength={MAX_DRIVE_NAME}
            placeholder={t("vault.namePlaceholder", { id: info.token_id })}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <ColorField label={t("vault.stroke")} value={stroke} onChange={setStroke} />
        <ColorField label={t("vault.fill")} value={fill} onChange={setFill} />
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" loading={busy} disabled={!dirty}>
            {t("common.save")}
          </Button>
          {saved && <span className="animate-fade-up text-sm text-success">{t("common.saved")}</span>}
        </div>
      </div>
      <div>
        <p className="text-sm font-medium">{t("vault.preview")}</p>
        <div style={driveVars(preview)} className="mt-2 flex flex-col gap-3">
          <DriveTile info={preview} />
          <div className="flex items-center gap-3">
            <span className="inline-flex h-8 shrink-0 items-center rounded-lg bg-accent px-3 text-sm font-medium text-accent-fg transition-colors">
              {t("files.upload")}
            </span>
            <span className="text-xs text-muted">{t("vault.accentHint")}</span>
          </div>
        </div>
      </div>
    </form>
  );
}
