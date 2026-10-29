"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Lock, LockOpen, Sparkles, Tag } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatEther } from "viem";
import { parseEventLogs } from "viem";
import { useWaitForTransactionReceipt, useWriteContract } from "wagmi";

import { useT } from "@/i18n";
import { api, ApiError, type VaultInfo } from "@/lib/api";
import { vaultNft } from "@/lib/contract";
import { IS_TESTNET } from "@/lib/chain";
import { formatBytes, formatCapacity } from "@/lib/format";
import { useTiers, type Tier } from "@/lib/tiers";
import { useUnlocked } from "@/lib/unlocked";

import { DriveTile } from "./drive/dialogs";
import { onOldContract } from "./drive/move-drive";
import { DriveArt } from "./drive-art";
import { freeBytes, UsageText } from "./drive-size";
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
          <span className="flex shrink-0 items-center gap-2 text-xs text-muted">
            {onOldContract(v) && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 font-medium text-amber-600 dark:text-amber-400">
                <ArrowUpRight className="h-3 w-3" />
                {t("drives.oldContract")}
              </span>
            )}
            {v.sale && (
              <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 font-medium text-accent">
                <Tag className="h-3 w-3" />
                {t("sale.forSale")}
              </span>
            )}
            <span className="flex items-center gap-1">
              <StatusIcon className="h-3 w-3" />
              {status}
            </span>
          </span>
        }
        footer={
          <div className="mt-1.5 flex justify-between text-xs text-muted">
            <span>
              <UsageText info={v} />
            </span>
            <span>{t("drives.free", { free: formatBytes(freeBytes(v)) })}</span>
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

/** Placeholders while the tiers are read from the contract (six, as on mainnet). */
const SKELETON_TIERS = 6;

/** The shape of a mint card, shimmering, while its tier is still loading. */
function MintCardSkeleton({ delay }: { delay: number }) {
  return (
    <div aria-hidden className="skeleton flex flex-col gap-4 rounded-xl border border-border bg-card p-5" style={{ animationDelay: `${delay}ms` }}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-1 flex-col gap-2">
          <div className="h-7 w-24 rounded-md bg-bg-subtle" />
          <div className="h-4 w-20 rounded bg-bg-subtle" />
          <div className="h-3 w-36 rounded bg-bg-subtle" />
        </div>
        <div className="h-14 w-14 shrink-0 rounded-xl bg-bg-subtle" />
      </div>
      <div className="h-9 rounded-lg bg-bg-subtle" />
    </div>
  );
}

/** A minted drive the server still doesn't confirm after this long is no longer waited for. */
const PENDING_GIVE_UP_MS = 10 * 60_000;

/** How long "Drive minted" stays. */
const MINTED_NOTE_MS = 5000;

function MintCard({ tier, popular, onMinted }: { tier: Tier; popular: boolean; onMinted: (tokenId: string | null) => void }) {
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
    <Card
      className={cn(
        "group relative flex flex-col gap-4 p-5 transition-transform duration-300",
        tier.active ? "hover:-translate-y-1" : "border-dashed opacity-70",
        popular && "border-accent shadow-xl shadow-accent/15",
      )}
    >
      {!tier.active && (
        <span className="absolute -top-2.5 left-5 rounded-full border border-border bg-bg px-2 py-0.5 text-[11px] text-muted">{t("drives.inactive")}</span>
      )}
      {popular && (
        <span className="absolute -top-2.5 left-5 rounded-full bg-accent px-2 py-0.5 text-[11px] font-medium text-accent-fg">{t("drives.popular")}</span>
      )}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-2xl font-semibold tracking-tight">{t("drives.capacity", { size: formatCapacity(tier.capacityGb) })}</div>
          <div className="mt-1 font-mono text-sm">{formatEther(tier.price)} ETH</div>
          <div className="mt-0.5 text-xs text-muted">{t("landing.perGb", { price: formatEther(tier.price / BigInt(tier.capacityGb)) })}</div>
        </div>
        <DriveArt
          capacityGb={tier.capacityGb}
          motion={tier.active ? (busy ? "always" : "hover") : "none"}
          className={cn("h-14 w-14 shrink-0 rounded-xl shadow-lg transition-transform duration-500 group-hover:-rotate-6", !tier.active && "grayscale")}
        />
      </div>
      <Button
        variant={popular ? "primary" : "secondary"}
        className="mt-auto"
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
  const { tiers, isLoading: tiersLoading } = useTiers();
  // "Popular": the tier on sale with the most drives minted (none until something sells).
  const stats = useQuery({ queryKey: ["tier-stats"], queryFn: api.tierStats, staleTime: 60_000 });
  const mintedIn = (id: number) => stats.data?.find((s) => s.tier_id === id)?.minted ?? 0;
  const popular = tiers
    .filter((x) => x.active && mintedIn(x.id) > 0)
    .reduce<Tier | undefined>((a, b) => (!a || mintedIn(b.id) > mintedIn(a.id) ? b : a), undefined)?.id;
  // Drives minted here that the list doesn't show yet: the server confirms a new token with
  // ownerOf, which a lagging RPC node may not answer at once, so keep asking.
  const [minted, setMinted] = useState<string[]>([]);
  const waiting = minted.filter((id) => !vaults.data?.some((v) => v.token_id === id));
  const onMinted = useCallback(
    (id: string | null) => {
      if (id) setMinted((m) => (m.includes(id) ? m : [...m, id]));
      qc.invalidateQueries({ queryKey: vaultsKey(token) });
      qc.invalidateQueries({ queryKey: ["tier-stats"] });
    },
    [qc, token],
  );
  const waitingKey = waiting.join(",");
  const waitingSince = useRef(new Map<string, number>());
  useEffect(() => {
    if (!waitingKey) return;
    const giveUp = (id: string) => setMinted((m) => m.filter((x) => x !== id));
    const check = () =>
      Promise.all(
        waitingKey.split(",").map((id) => {
          const since = waitingSince.current.get(id) ?? Date.now();
          waitingSince.current.set(id, since);
          if (Date.now() - since > PENDING_GIVE_UP_MS) return giveUp(id);
          return api.vault(token, id).catch((e) => {
            // Another wallet holds it (e.g. minted from a different account than the one signed in).
            if (e instanceof ApiError && e.status === 403) giveUp(id);
          });
        }),
      ).then(() => qc.invalidateQueries({ queryKey: vaultsKey(token) }));
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
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          {tiersLoading && Array.from({ length: SKELETON_TIERS }, (_, i) => <MintCardSkeleton key={i} delay={i * 120} />)}
          {tiers.map((tier) => (
            <MintCard key={tier.id} tier={tier} popular={tier.id === popular} onMinted={onMinted} />
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
