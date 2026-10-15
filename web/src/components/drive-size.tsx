"use client";

import { useT } from "@/i18n";
import type { VaultInfo } from "@/lib/api";
import { formatBytes } from "@/lib/format";

type Sizes = Pick<VaultInfo, "capacity_bytes" | "usable_bytes" | "used_bytes">;

/** The server is short of storage for this drive: it can hold less than was bought. */
export const isShort = (v: Pick<VaultInfo, "capacity_bytes" | "usable_bytes">) => v.usable_bytes < v.capacity_bytes;

/** How full the drive is (0..1) against what it can hold now; a drive that can hold nothing is full. */
export const fullness = (v: Sizes) => (v.usable_bytes > 0 ? v.used_bytes / v.usable_bytes : 1);

/** Bytes the drive can still take. */
export const freeBytes = (v: Sizes) => Math.max(0, v.usable_bytes - v.used_bytes);

/**
 * A drive's size: its capacity, or, while the server is short of storage, the capacity
 * struck through and what the drive can hold now (with the reason on hover).
 */
export function DriveSize({ info }: { info: Pick<VaultInfo, "capacity_bytes" | "usable_bytes"> }) {
  const t = useT();
  if (!isShort(info)) return <>{formatBytes(info.capacity_bytes)}</>;
  const capacity = formatBytes(info.capacity_bytes);
  const usable = formatBytes(info.usable_bytes);
  return (
    <span className="inline-flex items-baseline gap-1" title={t("drives.shortTitle", { usable, capacity })}>
      <s className="opacity-60">{capacity}</s>
      <span className="font-medium text-amber-600 dark:text-amber-400">{usable}</span>
    </span>
  );
}

/** "{used} of {size} used", with the size from `DriveSize`. */
export function UsageText({ info }: { info: Sizes }) {
  const t = useT();
  const [before, after] = t("drives.usage", { used: formatBytes(info.used_bytes), total: "\u0000" }).split("\u0000");
  return (
    <>
      {before}
      <DriveSize info={info} />
      {after}
    </>
  );
}
