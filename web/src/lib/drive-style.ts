import type { CSSProperties } from "react";

import type { Translate } from "@/i18n";

import type { VaultInfo } from "./api";

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
 * focus rings use the fill (or the stroke if only that is set); borders use the stroke.
 */
export function driveVars(v: Pick<VaultInfo, "stroke" | "fill">): CSSProperties {
  const accent = v.fill ?? v.stroke;
  const vars: Record<string, string> = {};
  if (accent) {
    vars["--accent"] = accent;
    vars["--accent-fg"] = contrastText(accent);
    vars["--accent-soft"] = `color-mix(in srgb, ${accent} 16%, var(--card))`;
  }
  if (v.stroke) vars["--drive-stroke"] = v.stroke;
  return vars as CSSProperties;
}

export const PRESET_COLORS = ["#4f46e5", "#0ea5e9", "#10b981", "#84cc16", "#f59e0b", "#f97316", "#ef4444", "#ec4899", "#a855f7", "#64748b"];
