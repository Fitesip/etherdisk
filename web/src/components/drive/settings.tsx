"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft, ExternalLink, Eraser, Lock, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { isAddress, isAddressEqual, zeroAddress, type Address } from "viem";
import { useConnection, usePublicClient, useWaitForTransactionReceipt, useWriteContract } from "wagmi";

import { useT } from "@/i18n";
import type { VaultInfo } from "@/lib/api";
import { CONTRACT_ADDRESS } from "@/lib/config";
import { vaultNft } from "@/lib/contract";
import { driveName } from "@/lib/drive-style";
import { formatBytes, shortAddress } from "@/lib/format";
import { IDLE_CHOICES, useLockSettings } from "@/lib/lock-settings";
import { useUnlocked } from "@/lib/unlocked";

import { Button, cn, Dialog, Input, Notice } from "../ui";
import { ChangePassphraseForm, DriveLookForm, LinksList, ResetDialog, type DriveCtx } from "./dialogs";

const CONFIRM_WORD = "TRANSFER";

/** Sends the drive NFT to another wallet (ERC-721 safeTransferFrom). */
export function TransferDialog({ open, onClose, token, info }: { open: boolean; onClose: () => void; token: string; info: VaultInfo }) {
  const t = useT();
  const qc = useQueryClient();
  const router = useRouter();
  const store = useUnlocked();
  const client = usePublicClient();
  const { address } = useConnection();
  const [to, setTo] = useState("");
  const [word, setWord] = useState("");
  const write = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash: write.data });

  const recipient = to.trim();
  const valid = isAddress(recipient, { strict: false }) && !isAddressEqual(recipient as Address, zeroAddress);
  const self = valid && !!address && isAddressEqual(recipient as Address, address);
  const code = useQuery({
    queryKey: ["code", recipient.toLowerCase()],
    queryFn: async () => (await client!.getCode({ address: recipient as Address })) ?? "0x",
    enabled: open && valid && !self && !!client,
  });
  const isContract = !!code.data && code.data !== "0x";

  // Once mined, the drive is no longer ours: forget its key and leave.
  useEffect(() => {
    if (!receipt.isSuccess) return;
    store.lock(info.token_id);
    qc.invalidateQueries({ queryKey: ["vaults", token] });
    router.push("/drive");
  }, [receipt.isSuccess, store, info.token_id, qc, token, router]);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid || self || word !== CONFIRM_WORD || !address) return;
    write.mutate({ ...vaultNft, functionName: "safeTransferFrom", args: [address, recipient as Address, BigInt(info.token_id)] });
  }

  const busy = write.isPending || receipt.isLoading;
  return (
    <Dialog open={open} onClose={busy ? () => {} : onClose} title={t("transfer.title", { name: driveName(info, t) })} tone="danger">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <p className="text-sm">{t("transfer.intro")}</p>
        <ul className="flex flex-col gap-2 text-sm text-muted">
          {(["point1", "point2", "point3", "point4"] as const).map((k) => (
            <li key={k} className="flex gap-2">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
              {t(`transfer.${k}`)}
            </li>
          ))}
        </ul>
        <label className="text-sm font-medium">
          {t("transfer.recipient")}
          <Input
            className="mt-2 font-mono font-normal"
            placeholder="0x…"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
          />
        </label>
        {recipient && !valid && <p className="-mt-2 text-xs text-danger">{t("transfer.invalidAddress")}</p>}
        {self && <p className="-mt-2 text-xs text-danger">{t("transfer.selfAddress")}</p>}
        {isContract && <Notice tone="danger">{t("transfer.contractWarning")}</Notice>}
        <label className="text-sm">
          {t("transfer.confirmLabel", { word: CONFIRM_WORD })}
          <Input className="mt-2 font-mono" value={word} onChange={(e) => setWord(e.target.value)} autoComplete="off" disabled={busy} />
        </label>
        {write.error && <Notice tone="danger">{write.error.message.split("\n")[0]}</Notice>}
        {receipt.isError && <Notice tone="danger">{t("common.error")}</Notice>}
        <Button type="submit" variant="danger" loading={busy} disabled={!valid || self || word !== CONFIRM_WORD}>
          <ArrowRightLeft className="h-4 w-4" />
          {write.isPending ? t("transfer.confirming") : receipt.isLoading ? t("transfer.pending") : t("transfer.submit")}
        </Button>
      </form>
    </Dialog>
  );
}

function Section({ title, text, tone, children }: { title: string; text?: string; tone?: "danger"; children: ReactNode }) {
  return (
    <section
      className={cn(
        "animate-fade-up rounded-xl border bg-card p-5 sm:p-6",
        tone === "danger" ? "border-danger/40" : "border-(--drive-stroke,var(--border))",
      )}
    >
      <h2 className={cn("font-semibold", tone === "danger" && "text-danger")}>{title}</h2>
      {text && <p className="mt-1 text-sm text-muted">{text}</p>}
      <div className="mt-5">{children}</div>
    </section>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn("relative h-6 w-11 shrink-0 rounded-full transition-colors", checked ? "bg-accent" : "bg-border")}
    >
      <span className={cn("absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform", checked && "translate-x-5")} />
    </button>
  );
}

function DangerRow({ title, text, action }: { title: string; text: string; action: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-sm text-muted">{text}</p>
      </div>
      {action}
    </div>
  );
}

/** The drive's Settings tab. Parts that need the key show an unlock prompt while locked. */
export function DriveSettingsPanel({ token, info }: { token: string; info: VaultInfo }) {
  const t = useT();
  const store = useUnlocked();
  const tokenId = info.token_id;
  const unlocked = store.get(tokenId);
  const [lock, setLock] = useLockSettings(tokenId);
  const [dialog, setDialog] = useState<"transfer" | "format" | null>(null);
  const ctx: DriveCtx | null = unlocked ? { token, tokenId, name: driveName(info, t), vault: unlocked.vault } : null;

  const needsUnlock = (
    <div className="flex flex-wrap items-center gap-3">
      <p className="text-sm text-muted">{t("driveSettings.unlockToChange")}</p>
      <Link href={`/drive/${tokenId}`} className="inline-flex h-8 items-center gap-2 rounded-lg bg-accent px-3 text-sm font-medium text-accent-fg">
        <Lock className="h-4 w-4" />
        {t("driveSettings.goUnlock")}
      </Link>
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      <Section title={t("driveSettings.general")} text={t("driveSettings.generalText")}>
        <DriveLookForm token={token} info={info} />
      </Section>

      <Section title={t("driveSettings.security")} text={t("driveSettings.deviceOnly")}>
        <div className="flex flex-col divide-y divide-border">
          <div className="flex flex-col gap-3 pb-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-medium">{t("driveSettings.autoLock")}</p>
              <p className="text-sm text-muted">{t("driveSettings.autoLockText")}</p>
            </div>
            <div role="radiogroup" aria-label={t("driveSettings.autoLock")} className="flex shrink-0 rounded-lg border border-border p-0.5">
              {IDLE_CHOICES.map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={lock.idleMinutes === m}
                  onClick={() => setLock({ idleMinutes: m })}
                  className={cn(
                    "h-8 rounded-md px-3 text-sm whitespace-nowrap transition-colors",
                    lock.idleMinutes === m ? "bg-accent text-accent-fg" : "text-muted hover:text-fg",
                  )}
                >
                  {m === 0 ? t("driveSettings.never") : t("driveSettings.minutes", { n: m })}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-start justify-between gap-4 py-5">
            <div>
              <p className="text-sm font-medium">{t("driveSettings.keepOnReload")}</p>
              <p className="text-sm text-muted">{t("driveSettings.keepOnReloadText")}</p>
            </div>
            <Toggle
              label={t("driveSettings.keepOnReload")}
              checked={lock.keepOnReload}
              onChange={(v) => {
                setLock({ keepOnReload: v });
                store.syncKept(tokenId);
              }}
            />
          </div>
          <div className="pt-5">
            <p className="mb-3 text-sm font-medium">{t("driveSettings.passphrase")}</p>
            <p className="mb-4 text-sm text-muted">{t("vault.changePassphraseText")}</p>
            {ctx && unlocked ? <ChangePassphraseForm ctx={ctx} etag={unlocked.etag} /> : needsUnlock}
          </div>
          {unlocked && (
            <div className="mt-5 pt-5">
              <Button onClick={() => store.lock(tokenId)}>
                <Lock className="h-4 w-4" />
                {t("driveSettings.lockNow")}
              </Button>
            </div>
          )}
        </div>
      </Section>

      <Section title={t("driveSettings.links")} text={t("share.revokedOnTransfer")}>
        {ctx ? <LinksList ctx={ctx} /> : needsUnlock}
      </Section>

      <Section title={t("driveSettings.about")}>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-muted">{t("driveSettings.token")}</dt>
          <dd className="font-mono">#{tokenId}</dd>
          <dt className="text-muted">{t("driveSettings.capacity")}</dt>
          <dd>{formatBytes(info.capacity_bytes)}</dd>
          <dt className="text-muted">{t("driveSettings.contract")}</dt>
          <dd>
            <a
              href={`https://sepolia.etherscan.io/nft/${CONTRACT_ADDRESS}/${tokenId}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-mono text-accent hover:underline"
            >
              {shortAddress(CONTRACT_ADDRESS)}
              <ExternalLink className="h-3 w-3" />
            </a>
          </dd>
        </dl>
      </Section>

      <Section title={t("driveSettings.danger")} tone="danger">
        <div className="flex flex-col divide-y divide-border">
          <DangerRow
            title={t("driveMenu.transfer")}
            text={t("driveSettings.transferText")}
            action={
              <Button variant="danger" className="shrink-0" onClick={() => setDialog("transfer")}>
                <ArrowRightLeft className="h-4 w-4" />
                {t("driveMenu.transfer")}
              </Button>
            }
          />
          <DangerRow
            title={t("driveMenu.format")}
            text={t("driveSettings.formatText")}
            action={
              <Button variant="danger" className="shrink-0" onClick={() => setDialog("format")}>
                <Eraser className="h-4 w-4" />
                {t("driveMenu.format")}
              </Button>
            }
          />
        </div>
      </Section>

      <TransferDialog open={dialog === "transfer"} onClose={() => setDialog(null)} token={token} info={info} />
      <ResetDialog open={dialog === "format"} onClose={() => setDialog(null)} token={token} tokenId={tokenId} />
    </div>
  );
}
