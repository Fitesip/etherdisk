import type { CSSProperties } from "react";

import type { Translate } from "@/i18n";

import type { VaultInfo } from "./api";

/** The mainnet tiers' colors (one per power of two, six in a cycle), until the contract's are read. */
const TIER_COLORS = ["#6366f1", "#10b981", "#f59e0b", "#ec4899", "#0ea5e9", "#a855f7"];
export const log2 = (x: number) => Math.floor(Math.log2(Math.max(1, x)));

/** Capacity (GB) -> the color of its tier in the contract (`getTier(..).color`). */
const contractColors = new Map<number, string>();
const colorListeners = new Set<() => void>();
let colorVersion = 0;

/** Called with the contract's tiers (lib/tiers.ts); redraws what shows tier colors. */
export function rememberTierColors(tiers: { capacityGb: number; color: string }[]) {
  let changed = false;
  for (const t of tiers) {
    if (contractColors.get(t.capacityGb) !== t.color) {
      contractColors.set(t.capacityGb, t.color);
      changed = true;
    }
  }
  if (!changed) return;
  colorVersion++;
  for (const l of colorListeners) l();
}
export const subscribeTierColors = (l: () => void) => {
  colorListeners.add(l);
  return () => void colorListeners.delete(l);
};
export const tierColorsVersion = () => colorVersion;

/** The color of the tier a drive of this size belongs to, as the NFT's picture uses it. */
export const tierColor = (capacityGb: number) => contractColors.get(capacityGb) ?? TIER_COLORS[log2(capacityGb) % 6];
const BYTES_PER_GB = 2 ** 30;

export const driveName = (v: Pick<VaultInfo, "token_id" | "name">, t: Translate) => v.name || t("drives.drive", { id: v.token_id });

/** Readable text color (black/white) on top of a #rrggbb background. */
export function contrastText(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  // Contrast against black vs white: (L+0.05)/0.05 vs 1.05/(L+0.05).
  return lum > 0.179 ? "#000000" : "#ffffff";
}

/**
 * CSS variables that recolor everything inside a drive: accent buttons, progress bars,
 * focus rings use the fill (or the stroke if only that is set, else the color of the drive's
 * size, as on its NFT); borders use the stroke.
 */
export function driveVars(v: Pick<VaultInfo, "stroke" | "fill"> & Partial<Pick<VaultInfo, "cover_color" | "capacity_bytes">>): CSSProperties {
  const accent = v.fill ?? v.stroke ?? (v.capacity_bytes ? tierColor(Math.round(v.capacity_bytes / BYTES_PER_GB)) : null);
  const vars: Record<string, string> = {};
  if (accent) {
    vars["--accent"] = accent;
    vars["--accent-fg"] = contrastText(accent);
    vars["--accent-soft"] = `color-mix(in srgb, ${accent} 16%, var(--card))`;
  }
  if (v.stroke) vars["--drive-stroke"] = v.stroke;
  if (v.cover_color) vars["--drive-cover"] = v.cover_color;
  return vars as CSSProperties;
}

export const PRESET_COLORS = ["#4f46e5", "#0ea5e9", "#10b981", "#84cc16", "#f59e0b", "#f97316", "#ef4444", "#ec4899", "#a855f7", "#64748b"];
