"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { useState, type FormEvent } from "react";

import { useT } from "@/i18n";
import type { WasmVault } from "@/lib/crypto";
import { takeOver } from "@/lib/drive-key";
import { passphraseValid } from "@/lib/passphrase";
import { useUnlocked } from "@/lib/unlocked";

import { PassphraseRules } from "../passphrase-rules";
import { Button, Card, Notice, PasswordInput } from "../ui";

/**
 * Shown right after unlocking a drive whose key another wallet made: the drive gets a new
 * key under a passphrase only the new owner knows. `vault` is the unlocked old key.
 */
export function NewKeyForm({ token, tokenId, name, vault, etag }: { token: string; tokenId: string; name: string; vault: WasmVault; etag: string }) {
  const t = useT();
  const qc = useQueryClient();
  const unlocked = useUnlocked();
  const [pass, setPass] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = passphraseValid(pass) && pass === repeat;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const done = await takeOver(token, tokenId, vault, pass, etag);
      vault.free();
      unlocked.set(tokenId, done);
      await qc.invalidateQueries({ queryKey: ["key", token, tokenId] });
      await qc.invalidateQueries({ queryKey: ["vault", token, tokenId] });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.error"));
      setBusy(false);
    }
  }

  return (
    <Card className="mx-auto mt-10 max-w-md animate-fade-up p-8">
      <div className="mb-4 grid h-12 w-12 place-items-center rounded-full bg-accent-soft text-accent">
        <ShieldCheck className="h-6 w-6" />
      </div>
      <h1 className="text-lg font-semibold">{t("newKey.title", { name })}</h1>
      <p className="mt-1 text-sm text-muted">{t("newKey.text")}</p>
      <form onSubmit={submit} className="mt-6 flex flex-col gap-3">
        <PasswordInput autoFocus autoComplete="new-password" placeholder={t("vault.newPassphrase")} value={pass} onChange={(e) => setPass(e.target.value)} />
        <PassphraseRules value={pass} />
        <PasswordInput autoComplete="new-password" placeholder={t("vault.passphraseRepeat")} value={repeat} onChange={(e) => setRepeat(e.target.value)} />
        {repeat && pass !== repeat && <p className="text-xs text-danger">{t("vault.passphraseMismatch")}</p>}
        {error && <Notice tone="danger">{error}</Notice>}
        <Button type="submit" variant="primary" loading={busy} disabled={!valid}>
          {t("newKey.submit")}
        </Button>
      </form>
    </Card>
  );
}
