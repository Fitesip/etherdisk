"use client";

import { useQueryClient } from "@tanstack/react-query";
import { KeyRound, ShieldAlert } from "lucide-react";
import { useState, type FormEvent } from "react";

import { useT } from "@/i18n";
import { api } from "@/lib/api";
import { fromB64, loadCrypto, nextFrame, toB64, WasmVault } from "@/lib/crypto";
import { passphraseValid } from "@/lib/passphrase";
import { useUnlocked } from "@/lib/unlocked";

import { PassphraseRules } from "../passphrase-rules";
import { Button, Card, Input, Notice } from "../ui";
import { ResetDialog } from "./dialogs";

function Shell({ title, text, children }: { title: string; text: string; children: React.ReactNode }) {
  return (
    <Card className="mx-auto mt-10 max-w-md p-8">
      <div className="mb-4 grid h-12 w-12 place-items-center rounded-full bg-accent-soft text-accent">
        <KeyRound className="h-6 w-6" />
      </div>
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="mt-1 text-sm text-muted">{text}</p>
      <div className="mt-6">{children}</div>
    </Card>
  );
}

/** First use (or after a reset): choose the passphrase, create the drive key. */
export function SetupForm({ token, tokenId, name }: { token: string; tokenId: string; name: string }) {
  const t = useT();
  const qc = useQueryClient();
  const unlocked = useUnlocked();
  const [pass, setPass] = useState("");
  const [repeat, setRepeat] = useState("");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = passphraseValid(pass);
  const mismatch = repeat.length > 0 && pass !== repeat;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid || pass !== repeat || !ack) return;
    setBusy(true);
    setError(null);
    try {
      await loadCrypto();
      await nextFrame();
      const vault = WasmVault.create(pass);
      try {
        const saved = await api.putKey(token, tokenId, toB64(vault.keyBlob), null);
        unlocked.set(tokenId, { vault, etag: saved.etag });
      } catch (err) {
        vault.free();
        throw err;
      }
      await qc.invalidateQueries({ queryKey: ["vault", token, tokenId] });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.error"));
      setBusy(false);
    }
  }

  return (
    <Shell title={t("vault.setupTitle", { name })} text={t("vault.setupText")}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Input type="password" autoComplete="new-password" placeholder={t("vault.passphrase")} value={pass} onChange={(e) => setPass(e.target.value)} />
        <PassphraseRules value={pass} />
        <Input type="password" autoComplete="new-password" placeholder={t("vault.passphraseRepeat")} value={repeat} onChange={(e) => setRepeat(e.target.value)} />
        {mismatch && <p className="text-xs text-danger">{t("vault.passphraseMismatch")}</p>}
        <div className="flex gap-2 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
          <ShieldAlert className="h-4 w-4 shrink-0" />
          {t("vault.setupWarning")}
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          {t("vault.setupAck")}
        </label>
        {error && <Notice tone="danger">{error}</Notice>}
        <Button type="submit" variant="primary" loading={busy} disabled={!valid || pass !== repeat || !ack}>
          {busy ? t("vault.creating") : t("vault.create")}
        </Button>
      </form>
    </Shell>
  );
}

export function UnlockForm({
  token,
  tokenId,
  name,
  keyBlob,
  etag,
}: {
  token: string;
  tokenId: string;
  name: string;
  keyBlob: string;
  etag: string;
}) {
  const t = useT();
  const unlocked = useUnlocked();
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [wrong, setWrong] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!pass) return;
    setBusy(true);
    setWrong(false);
    await loadCrypto();
    await nextFrame();
    try {
      unlocked.set(tokenId, { vault: WasmVault.unlock(fromB64(keyBlob), pass), etag });
    } catch {
      setWrong(true);
      setBusy(false);
    }
  }

  return (
    <Shell title={t("vault.unlockTitle", { name })} text={t("vault.unlockText")}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Input type="password" autoFocus autoComplete="current-password" placeholder={t("vault.passphrase")} value={pass} onChange={(e) => setPass(e.target.value)} />
        {wrong && <p className="text-xs text-danger">{t("vault.wrongPassphrase")}</p>}
        <Button type="submit" variant="primary" loading={busy} disabled={!pass}>
          {busy ? t("vault.unlocking") : t("vault.unlock")}
        </Button>
        <p className="text-xs text-muted">{t("vault.unlockTransferHint")}</p>
        <button type="button" className="self-start text-xs text-danger underline" onClick={() => setResetOpen(true)}>
          {t("vault.noPassphrase")}
        </button>
      </form>
      <ResetDialog open={resetOpen} onClose={() => setResetOpen(false)} token={token} tokenId={tokenId} />
    </Shell>
  );
}
