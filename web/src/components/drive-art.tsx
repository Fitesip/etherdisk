import { useId } from "react";

import { cn } from "./ui";
import { formatCapacity } from "@/lib/format";

// The token's picture, as EtherdiskArt.sol draws it (same colors, rings and layout), plus
// motion for the landing page: the platter spins and the read arm seeks.

const COLORS = ["#6366f1", "#10b981", "#f59e0b", "#ec4899", "#0ea5e9", "#a855f7"];

const log2 = (x: number) => Math.floor(Math.log2(Math.max(1, x)));
export const driveColor = (capacityGb: number) => COLORS[log2(capacityGb) % 6];
const ringCount = (capacityGb: number) => {
  const n = log2(capacityGb);
  return n < 6 ? 4 : n > 12 ? 10 : n - 2;
};

export function DriveArt({
  capacityGb,
  tokenId,
  motion = "always",
  className,
}: {
  capacityGb: number;
  tokenId?: number;
  /** "hover": spins only while an ancestor with the `group` class is hovered. */
  motion?: "always" | "hover" | "none";
  className?: string;
}) {
  const id = useId().replace(/:/g, "");
  const c = driveColor(capacityGb);
  const label = formatCapacity(capacityGb);
  const rings = ringCount(capacityGb);

  return (
    <svg
      viewBox="0 0 400 400"
      className={cn("drive-art", motion !== "none" && `drive-art-${motion}`, className)}
      fontFamily="ui-sans-serif,system-ui,sans-serif"
      role="img"
      aria-label={`Etherdisk ${label}`}
    >
      <defs>
        <linearGradient id={`m${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2a2a30" />
          <stop offset="1" stopColor="#141417" />
        </linearGradient>
        <radialGradient id={`p${id}`} cx="45%" cy="40%" r="70%">
          <stop offset="0" stopColor="#3a3a42" />
          <stop offset="1" stopColor="#16161a" />
        </radialGradient>
        <linearGradient id={`s${id}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0.16" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="400" height="400" rx="28" fill="#0b0b0d" />
      <rect x="70" y="28" width="260" height="344" rx="18" fill={`url(#m${id})`} stroke="#fff" strokeOpacity=".1" />
      <path d="M88 28h224a18 18 0 0 1 18 18v22H70V46a18 18 0 0 1 18-18z" fill={c} />
      <text x="92" y="54" fill="#fff" fontSize="12" fontWeight="700" letterSpacing="3">
        ETHERDISK
      </text>
      {tokenId !== undefined && (
        <text x="308" y="54" textAnchor="end" fill="#fff" fontSize="12" fontFamily="ui-monospace,monospace">
          #{tokenId}
        </text>
      )}

      <circle cx="200" cy="220" r="118" fill={`url(#p${id})`} stroke={c} strokeWidth="2" />
      {/* Everything that turns with the platter: the tracks, a sheen and a few written sectors. */}
      <g className="drive-art-platter">
        {Array.from({ length: rings }, (_, i) => (
          <circle
            key={i}
            cx="200"
            cy="220"
            r={108 - 7 * i}
            fill="none"
            stroke={i % 3 === 0 ? c : "#fff"}
            strokeOpacity={i % 3 === 0 ? 0.35 : 0.07}
          />
        ))}
        <path d="M200 220L318 220A118 118 0 0 0 283 136Z" fill={`url(#s${id})`} />
        {Array.from({ length: rings }, (_, i) => (
          <circle key={i} cx={200 + (108 - 7 * i) * Math.cos(i * 2.1)} cy={220 + (108 - 7 * i) * Math.sin(i * 2.1)} r="2.2" fill={c} opacity=".8" />
        ))}
      </g>
      <circle cx="200" cy="220" r="40" fill="#0b0b0d" stroke={c} strokeWidth="3" />
      <text x="200" y="227" textAnchor="middle" fill="#fff" fontSize={label.length > 5 ? 17 : 19} fontWeight="800">
        {label}
      </text>

      <g className="drive-art-arm">
        <path d="M302 350L262 268" stroke="#c9ccd3" strokeWidth="7" strokeLinecap="round" />
        <circle cx="262" cy="268" r="4" fill={c} />
      </g>
      <circle cx="302" cy="350" r="13" fill="#c9ccd3" />
      <circle cx="88" cy="354" r="5" fill="#3a3a42" stroke="#0b0b0d" />
      <circle cx="312" cy="86" r="5" fill="#3a3a42" stroke="#0b0b0d" />
    </svg>
  );
}
