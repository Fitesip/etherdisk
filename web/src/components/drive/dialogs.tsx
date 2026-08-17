"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronRight, Copy, Folder, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";

import { useT } from "@/i18n";
import { api, ApiError } from "@/lib/api";
import { MIN_PASSPHRASE_LENGTH } from "@/lib/config";
import { fromB64, nextFrame, toB64, type WasmVault } from "@/lib/crypto";
import { formatDate } from "@/lib/format";
import { itemName, openItem, sealMeta, type Item } from "@/lib/meta";
import { createShare, openOwnerShareMeta, shareLink } from "@/lib/share";
import { useUnlocked } from "@/lib/unlocked";

import { Button, Dialog, Input, Notice, Spinner } from "../ui";

export interface DriveCtx {
  token: string;
  tokenId: string;
  vault: WasmVault;
}

function useInvalidate(token: string, tokenId: string) {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["objects", token, tokenId] }),
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
    <Dialog open={open} onClose={onClose} title={t("vault.resetTitle")}>
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

export function ChangePassphraseDialog({ open, onClose, ctx, etag }: { open: boolean; onClose: () => void; ctx: DriveCtx; etag: string }) {
  const t = useT();
  const unlocked = useUnlocked();
  const [pass, setPass] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const valid = pass.length >= MIN_PASSPHRASE_LENGTH && pass === repeat;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
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
    <Dialog
      open={open}
      onClose={() => {
        setDone(false);
        onClose();
      }}
      title={t("vault.changePassphrase")}
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        <p className="text-sm text-muted">{t("vault.changePassphraseText")}</p>
        <Input type="password" autoComplete="new-password" placeholder={t("vault.newPassphrase")} value={pass} onChange={(e) => setPass(e.target.value)} />
        {pass && pass.length < MIN_PASSPHRASE_LENGTH && (
          <p className="text-xs text-muted">{t("vault.passphraseTooShort", { n: MIN_PASSPHRASE_LENGTH })}</p>
        )}
        <Input type="password" autoComplete="new-password" placeholder={t("vault.passphraseRepeat")} value={repeat} onChange={(e) => setRepeat(e.target.value)} />
        {repeat && pass !== repeat && <p className="text-xs text-danger">{t("vault.passphraseMismatch")}</p>}
        {error && <Notice tone="danger">{error}</Notice>}
        {done && <p className="text-sm text-success">{t("vault.passphraseChanged")}</p>}
        <Button type="submit" variant="primary" loading={busy} disabled={!valid}>
          {t("common.save")}
        </Button>
      </form>
    </Dialog>
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

export async function createFolder(ctx: DriveCtx, parentId: string | null, name: string) {
  const id = crypto.randomUUID();
  await api.createFolder(ctx.token, ctx.tokenId, { id, parent_id: parentId, metadata: sealMeta(ctx.vault, id, { v: 1, name }) });
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
            {t("files.root", { id: ctx.tokenId })}
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

export function LinksDialog({ open, onClose, ctx }: { open: boolean; onClose: () => void; ctx: DriveCtx }) {
  const t = useT();
  const qc = useQueryClient();
  const shares = useQuery({
    queryKey: ["shares", ctx.token, ctx.tokenId],
    queryFn: () => api.shares(ctx.token, ctx.tokenId),
    enabled: open,
  });

  async function revoke(id: string) {
    await api.revokeShare(ctx.token, ctx.tokenId, id).catch((e) => {
      if (!(e instanceof ApiError && e.status === 404)) throw e;
    });
    await qc.invalidateQueries({ queryKey: ["shares", ctx.token, ctx.tokenId] });
  }

  return (
    <Dialog open={open} onClose={onClose} title={t("share.linksTitle", { id: ctx.tokenId })} wide>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">{t("share.revokedOnTransfer")}</p>
        {shares.isLoading ? (
          <Spinner />
        ) : !shares.data?.length ? (
          <p className="text-sm text-muted">{t("share.noLinks")}</p>
        ) : (
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
        )}
      </div>
    </Dialog>
  );
}
