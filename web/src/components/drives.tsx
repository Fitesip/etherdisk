"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, LockOpen, Sparkles } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { formatEther } from "viem";
import { useWaitForTransactionReceipt, useWriteContract } from "wagmi";

import { useT } from "@/i18n";
import { api, type VaultInfo } from "@/lib/api";
import { vaultNft } from "@/lib/contract";
import { formatBytes } from "@/lib/format";
import { useTiers, type Tier } from "@/lib/tiers";
import { useUnlocked } from "@/lib/unlocked";

import { DriveTile } from "./drive/dialogs";
import { InboxHint, OutgoingHandovers } from "./handover";
import { RequireSession } from "./require-session";
import { Button, Card, Notice, Spinner } from "./ui";

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

function MintCard({ tier, onMinted }: { tier: Tier; onMinted: () => void }) {
  const t = useT();
  const write = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash: write.data });

  useEffect(() => {
    if (receipt.isSuccess) onMinted();
  }, [receipt.isSuccess, onMinted]);

  const busy = write.isPending || receipt.isLoading;
  return (
    <Card className="flex flex-col gap-4 p-5">
      <div>
        <div className="text-2xl font-semibold tracking-tight">{t("drives.capacity", { gb: tier.capacityGb })}</div>
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
      {receipt.isSuccess && <p className="text-xs text-success">{t("drives.minted")}</p>}
      {write.error && <p className="text-xs text-danger">{write.error.message.split("\n")[0]}</p>}
    </Card>
  );
}

function Drives({ token }: { token: string }) {
  const t = useT();
  const qc = useQueryClient();
  const vaults = useQuery({ queryKey: vaultsKey(token), queryFn: () => api.vaults(token) });
  const { tiers } = useTiers();

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
          ) : vaults.data?.length ? (
            <div className="grid gap-3 md:grid-cols-2">
              {vaults.data.map((v) => (
                <DriveCard key={v.token_id} v={v} />
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
        <p className="mt-1 text-sm text-muted">{t("drives.mintText")}</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {tiers.map((tier) => (
            <MintCard key={tier.id} tier={tier} onMinted={() => qc.invalidateQueries({ queryKey: vaultsKey(token) })} />
          ))}
        </div>
      </section>
    </div>
  );
}

export function DrivesView() {
  return <RequireSession>{(token) => <Drives token={token} />}</RequireSession>;
}
