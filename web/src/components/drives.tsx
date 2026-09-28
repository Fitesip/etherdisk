"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, LockOpen, Sparkles } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { formatEther } from "viem";
import { parseEventLogs } from "viem";
import { useWaitForTransactionReceipt, useWriteContract } from "wagmi";

import { useT } from "@/i18n";
import { api, type VaultInfo } from "@/lib/api";
import { vaultNft } from "@/lib/contract";
import { IS_TESTNET } from "@/lib/chain";
import { formatBytes, formatCapacity } from "@/lib/format";
import { useTiers, type Tier } from "@/lib/tiers";
import { useUnlocked } from "@/lib/unlocked";

import { DriveTile } from "./drive/dialogs";
import { InboxHint, OutgoingHandovers } from "./handover";
import { RequireSession } from "./require-session";
import { Button, Card, cn, Notice, Spinner } from "./ui";

export const vaultsKey = (token: string) => ["vaults", token];

function DriveCard({ v }: { v: VaultInfo }) {
  const t = useT();
  const unlocked = !!useUnlocked().get(v.token_id);
  const status = !v.initialized ? t("drives.notSetUp") : unlocked ? t("drives.unlocked") : t("drives.locked");
  const StatusIcon = unlocked ? LockOpen : Lock;
  return (
    <Link href={`/drive/${v.token_id}`} className="rounded-xl transition hover:-translate-y-0.5 hover:shadow-md">
      <DriveTile
        info={v}
        status={
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted">
            <StatusIcon className="h-3 w-3" />
            {status}
          </span>
        }
        footer={
          <div className="mt-1.5 flex justify-between text-xs text-muted">
            <span>{t("drives.usage", { used: formatBytes(v.used_bytes), total: formatBytes(v.capacity_bytes) })}</span>
            <span>{t("drives.free", { free: formatBytes(Math.max(0, v.capacity_bytes - v.used_bytes)) })}</span>
          </div>
        }
      />
    </Link>
  );
}

/** A drive just minted that the server hasn't listed yet. */
function PendingDriveCard({ id }: { id: string }) {
  const t = useT();
  return (
    <Card className="flex animate-pulse items-center gap-4 p-4">
      <div className="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-bg-subtle">
        <Spinner className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-medium">{t("drives.pendingTitle", { id })}</div>
        <div className="mt-1 text-xs text-muted">{t("drives.pendingText")}</div>
        <div className="mt-3 h-1.5 w-2/3 rounded-full bg-bg-subtle" />
      </div>
    </Card>
  );
}

/** How long "Drive minted" stays. */
const MINTED_NOTE_MS = 5000;

function MintCard({ tier, onMinted }: { tier: Tier; onMinted: (tokenId: string | null) => void }) {
  const t = useT();
  const write = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash: write.data });

  // Hand the new token id to the list, which waits for the server to confirm it.
  const [noteHiddenFor, setNoteHiddenFor] = useState<string | undefined>();
  useEffect(() => {
    if (!receipt.isSuccess) return;
    const minted = parseEventLogs({ abi: vaultNft.abi, eventName: "DriveMinted", logs: receipt.data.logs })[0];
    onMinted(minted ? minted.args.tokenId.toString() : null);
    const timer = setTimeout(() => setNoteHiddenFor(write.data), MINTED_NOTE_MS);
    return () => clearTimeout(timer);
  }, [receipt.isSuccess, receipt.data, write.data, onMinted]);

  const busy = write.isPending || receipt.isLoading;
  return (
    <Card className={cn("relative flex flex-col gap-4 p-5", !tier.active && "opacity-70")}>
      {!tier.active && (
        <span className="absolute top-4 right-4 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted">{t("drives.inactive")}</span>
      )}
      <div>
        <div className="text-2xl font-semibold tracking-tight">{t("drives.capacity", { size: formatCapacity(tier.capacityGb) })}</div>
        <div className="font-mono text-sm text-muted">{formatEther(tier.price)} ETH</div>
      </div>
      <Button
        variant="primary"
        disabled={!tier.active}
        loading={busy}
        onClick={() => write.mutate({ ...vaultNft, functionName: "mint", args: [BigInt(tier.id)], value: tier.price })}
      >
        {!tier.active
          ? t("drives.inactive")
          : write.isPending
            ? t("drives.minting")
            : receipt.isLoading
              ? t("drives.mintPending")
              : t("drives.mint", { price: formatEther(tier.price) })}
      </Button>
      {receipt.isSuccess && noteHiddenFor !== write.data && <p className="animate-fade-up text-xs text-success">{t("drives.minted")}</p>}
      {write.error && <p className="text-xs text-danger">{write.error.message.split("\n")[0]}</p>}
    </Card>
  );
}

function Drives({ token }: { token: string }) {
  const t = useT();
  const qc = useQueryClient();
  const vaults = useQuery({ queryKey: vaultsKey(token), queryFn: () => api.vaults(token) });
  const { tiers } = useTiers();
  // Drives minted here that the list doesn't show yet: the server confirms a new token with
  // ownerOf, which a lagging RPC node may not answer at once, so keep asking.
  const [minted, setMinted] = useState<string[]>([]);
  const waiting = minted.filter((id) => !vaults.data?.some((v) => v.token_id === id));
  const onMinted = useCallback(
    (id: string | null) => {
      if (id) setMinted((m) => (m.includes(id) ? m : [...m, id]));
      qc.invalidateQueries({ queryKey: vaultsKey(token) });
    },
    [qc, token],
  );
  const waitingKey = waiting.join(",");
  useEffect(() => {
    if (!waitingKey) return;
    const check = () =>
      Promise.all(waitingKey.split(",").map((id) => api.vault(token, id).catch(() => null))).then(() =>
        qc.invalidateQueries({ queryKey: vaultsKey(token) }),
      );
    check();
    const timer = setInterval(check, 3000);
    return () => clearInterval(timer);
  }, [waitingKey, token, qc]);

  return (
    <div className="flex flex-col gap-12">
      <InboxHint token={token} />
      <section>
        <h1 className="text-2xl font-semibold tracking-tight">{t("drives.title")}</h1>
        <div className="mt-6">
          {vaults.isLoading ? (
            <Spinner />
          ) : vaults.error ? (
            <Notice tone="danger">{t("errors.network")}</Notice>
          ) : vaults.data?.length || waiting.length ? (
            <div className="grid gap-3 md:grid-cols-2">
              {vaults.data?.map((v) => (
                <DriveCard key={v.token_id} v={v} />
              ))}
              {waiting.map((id) => (
                <PendingDriveCard key={id} id={id} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted">{t("drives.empty")}</p>
          )}
        </div>
      </section>

      <OutgoingHandovers token={token} />

      <section>
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Sparkles className="h-4 w-4 text-accent" />
          {t("drives.mintTitle")}
        </h2>
        <p className="mt-1 text-sm text-muted">{IS_TESTNET ? t("drives.mintText") : t("drives.mintTextMainnet")}</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {tiers.map((tier) => (
            <MintCard key={tier.id} tier={tier} onMinted={onMinted} />
          ))}
        </div>
        <p className="mt-3 text-xs text-muted">
          {t("drives.agreeStart")}{" "}
          <Link href="/terms" className="underline hover:text-fg">
            {t("landing.terms")}
          </Link>{" "}
          {t("drives.agreeAnd")}{" "}
          <Link href="/privacy" className="underline hover:text-fg">
            {t("landing.privacy")}
          </Link>
          .
        </p>
      </section>
    </div>
  );
}

export function DrivesView() {
  return <RequireSession>{(token) => <Drives token={token} />}</RequireSession>;
}
