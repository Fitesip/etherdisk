"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react";
import { useEffect } from "react";
import type { Address } from "viem";
import { useConnection, useWaitForTransactionReceipt, useWriteContract } from "wagmi";

import { useT } from "@/i18n";
import type { VaultInfo } from "@/lib/api";
import { CONTRACT_ADDRESS } from "@/lib/config";
import { vaultNftAbi } from "@/lib/contract";

import { Button } from "../ui";

/** Whether the drive still lives on an earlier contract: it opens and downloads, nothing more. */
export const onOldContract = (info: Pick<VaultInfo, "legacy_contract">) => !!info.legacy_contract;

/**
 * A drive on an earlier contract (docs/MIGRATION.md): the old NFT goes to the new contract,
 * which gives back the same number and capacity in the same transaction. Files, the key and
 * links stay. Until the server sees the move, the drive stays read-only.
 */
export function MoveDriveBanner({ token, info }: { token: string; info: VaultInfo }) {
  const t = useT();
  const qc = useQueryClient();
  const { address } = useConnection();
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
    if (!address || !info.legacy_contract) return;
    write.mutate({
      address: info.legacy_contract as Address,
      abi: vaultNftAbi,
      functionName: "safeTransferFrom",
      args: [address, CONTRACT_ADDRESS, BigInt(info.token_id)],
    });
  };

  const failed = write.error ?? receipt.error;
  const busy = write.isPending || receipt.isLoading || receipt.isSuccess;
  return (
    <div role="status" className="flex flex-col gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm sm:flex-row sm:items-center">
      <div className="flex-1">
        <p className="font-medium">{t("move.title")}</p>
        <p className="mt-1 text-muted">{t("move.text")}</p>
        {failed && <p className="mt-2 text-danger">{"shortMessage" in failed ? String(failed.shortMessage) : failed.message}</p>}
      </div>
      <Button variant="primary" onClick={move} disabled={busy || !address} className="shrink-0">
        <ArrowUpRight className="h-4 w-4" />
        {write.isPending ? t("move.confirm") : receipt.isLoading ? t("move.pending") : receipt.isSuccess ? t("move.finishing") : t("move.button")}
      </Button>
    </div>
  );
}
