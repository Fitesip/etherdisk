"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react";
import { useEffect } from "react";
import { isAddressEqual, zeroAddress, type Address } from "viem";
import { useConnection, usePublicClient, useWaitForTransactionReceipt, useWriteContract } from "wagmi";

import { useT } from "@/i18n";
import type { VaultInfo } from "@/lib/api";
import { CONTRACT_ADDRESS } from "@/lib/config";
import { vaultNftAbi } from "@/lib/contract";

import { Button } from "../ui";

/** Whether the drive still lives on an earlier contract: it opens and downloads, nothing more. */
export const onOldContract = (info: Pick<VaultInfo, "legacy_contract">) => !!info.legacy_contract;

/**
 * The contract that takes `old`'s drives: each version takes only the one before it, so a
 * drive several versions behind moves one step at a time. Read from the chain (from the
 * current contract back), not taken from the server; null if `old` isn't one of ours.
 */
async function successorOf(client: NonNullable<ReturnType<typeof usePublicClient>>, old: Address): Promise<Address | null> {
  let next = CONTRACT_ADDRESS;
  for (let i = 0; i < 32; i++) {
    const legacy = await client.readContract({ address: next, abi: vaultNftAbi, functionName: "legacy" });
    if (isAddressEqual(legacy, zeroAddress)) return null;
    if (isAddressEqual(legacy, old)) return next;
    next = legacy;
  }
  return null;
}

/**
 * A drive on an earlier contract (docs/MIGRATION.md): the old NFT goes to the new contract,
 * which gives back the same number and capacity in the same transaction. Files, the key and
 * links stay. Until the server sees the move, the drive stays read-only.
 */
export function MoveDriveBanner({ token, info }: { token: string; info: VaultInfo }) {
  const t = useT();
  const qc = useQueryClient();
  const { address } = useConnection();
  const client = usePublicClient();
  const target = useQuery({
    queryKey: ["successor", info.legacy_contract],
    queryFn: () => successorOf(client!, info.legacy_contract as Address),
    enabled: !!client && !!info.legacy_contract,
    staleTime: Infinity,
  });
  const write = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash: write.data });

  // Mined: ask again until the server has seen the move (the banner goes away with it).
  useEffect(() => {
    if (!receipt.isSuccess) return;
    const ask = () => {
      qc.invalidateQueries({ queryKey: ["vault", token, info.token_id] });
      qc.invalidateQueries({ queryKey: ["vaults", token] });
    };
    ask();
    const timer = setInterval(ask, 3000);
    return () => clearInterval(timer);
  }, [receipt.isSuccess, qc, token, info.token_id]);

  const move = () => {
    if (!address || !info.legacy_contract || !target.data) return;
    write.mutate({
      address: info.legacy_contract as Address,
      abi: vaultNftAbi,
      functionName: "safeTransferFrom",
      args: [address, target.data, BigInt(info.token_id)],
    });
  };

  const failed = write.error ?? receipt.error ?? target.error;
  const busy = write.isPending || receipt.isLoading || receipt.isSuccess;
  return (
    <div role="status" className="flex flex-col gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm sm:flex-row sm:items-center">
      <div className="flex-1">
        <p className="font-medium">{t("move.title")}</p>
        <p className="mt-1 text-muted">{t("move.text")}</p>
        {target.data === null && <p className="mt-2 text-danger">{t("move.unknown")}</p>}
        {failed && <p className="mt-2 text-danger">{"shortMessage" in failed ? String(failed.shortMessage) : failed.message}</p>}
      </div>
      <Button variant="primary" onClick={move} disabled={busy || !address || !target.data} className="shrink-0">
        <ArrowUpRight className="h-4 w-4" />
        {write.isPending ? t("move.confirm") : receipt.isLoading ? t("move.pending") : receipt.isSuccess ? t("move.finishing") : t("move.button")}
      </Button>
    </div>
  );
}
