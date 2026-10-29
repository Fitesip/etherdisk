"use client";

import { useEffect } from "react";
import { useReadContract, useReadContracts } from "wagmi";

import { vaultNft } from "./contract";
import { rememberTierColors } from "./drive-style";

export interface Tier {
  id: number;
  capacityGb: number;
  price: bigint;
  active: boolean;
  /** Left out of the site's lists by the owner (its drives are unaffected). */
  hidden: boolean;
  /** "#rrggbb" */
  color: string;
}

const hex = (rgb: number) => `#${rgb.toString(16).padStart(6, "0")}`;

/**
 * The tiers from the contract (read straight from the chain, no wallet needed), without the
 * hidden ones. Their colors become the drives' colors everywhere (lib/drive-style.ts).
 */
export function useTiers(): { tiers: Tier[]; isLoading: boolean } {
  const count = useReadContract({ ...vaultNft, functionName: "tierCount" });
  const n = Number(count.data ?? 0);
  const tiers = useReadContracts({
    contracts: Array.from({ length: n }, (_, i) => ({ ...vaultNft, functionName: "getTier", args: [BigInt(i)] }) as const),
    query: { enabled: n > 0 },
  });
  const all: Tier[] = (tiers.data ?? []).flatMap((r, id) =>
    r.status === "success"
      ? [{ id, capacityGb: r.result.capacityGb, price: r.result.price, active: r.result.active, hidden: r.result.hidden, color: hex(r.result.color) }]
      : [],
  );
  useEffect(() => rememberTierColors(all), [all]);
  return { tiers: all.filter((t) => !t.hidden), isLoading: count.isLoading || tiers.isLoading };
}
