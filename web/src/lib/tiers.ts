"use client";

import { useReadContract, useReadContracts } from "wagmi";

import { vaultNft } from "./contract";

export interface Tier {
  id: number;
  capacityGb: number;
  price: bigint;
  active: boolean;
}

/** All tiers from the contract (read straight from the chain, no wallet needed). */
export function useTiers(): { tiers: Tier[]; isLoading: boolean } {
  const count = useReadContract({ ...vaultNft, functionName: "tierCount" });
  const n = Number(count.data ?? 0);
  const tiers = useReadContracts({
    contracts: Array.from({ length: n }, (_, i) => ({ ...vaultNft, functionName: "getTier", args: [BigInt(i)] }) as const),
    query: { enabled: n > 0 },
  });
  const list: Tier[] = (tiers.data ?? []).flatMap((r, id) =>
    r.status === "success" ? [{ id, capacityGb: r.result.capacityGb, price: r.result.price, active: r.result.active }] : [],
  );
  return { tiers: list, isLoading: count.isLoading || tiers.isLoading };
}
