// Icons and cover patterns for drives and folders. A drive's icon and cover are stored by
// id in its plaintext profile; a folder's in its encrypted metadata. Unknown ids fall back
// to the defaults, so removing one from these sets breaks nothing.

import {
  Archive,
  BookOpen,
  Briefcase,
  Camera,
  Code,
  Film,
  Folder,
  Gamepad2,
  GraduationCap,
  HardDrive,
  Heart,
  Home,
  Image as ImageIcon,
  KeyRound,
  Music,
  Palette,
  PiggyBank,
  Plane,
  Shield,
  ShoppingBag,
  Sparkles,
  Star,
  type LucideIcon,
} from "lucide-react";
import { createElement, type CSSProperties } from "react";

/** Shared by drives and folders; the first entry of each list below is the default. */
const ICONS: Record<string, LucideIcon> = {
  "hard-drive": HardDrive,
  folder: Folder,
  camera: Camera,
  image: ImageIcon,
  film: Film,
  music: Music,
  briefcase: Briefcase,
  book: BookOpen,
  "graduation-cap": GraduationCap,
  code: Code,
  gamepad: Gamepad2,
  palette: Palette,
  home: Home,
  heart: Heart,
  plane: Plane,
  "shopping-bag": ShoppingBag,
  "piggy-bank": PiggyBank,
  archive: Archive,
  key: KeyRound,
  shield: Shield,
  star: Star,
  sparkles: Sparkles,
};

export const DRIVE_ICON_IDS = Object.keys(ICONS).filter((id) => id !== "folder");
export const FOLDER_ICON_IDS = ["folder", ...DRIVE_ICON_IDS.filter((id) => id !== "hard-drive")];

type IconProps = { id: string | null | undefined; className?: string; style?: CSSProperties };

/** A drive's icon by id (default: a hard drive). */
export const DriveIcon = ({ id, ...props }: IconProps) => createElement((id && ICONS[id]) || HardDrive, props);
/** A folder's icon by id (default: a folder). */
export const FolderIcon = ({ id, ...props }: IconProps) => createElement((id && ICONS[id]) || Folder, props);

/** Cover patterns for drive cards, drawn in the drive's accent color (`--accent`). */
const COVERS: Record<string, string> = {
  dots: "radial-gradient(color-mix(in srgb, var(--accent) 45%, transparent) 1.2px, transparent 1.6px) 0 0 / 12px 12px",
  grid: "linear-gradient(color-mix(in srgb, var(--accent) 22%, transparent) 1px, transparent 1px) 0 0 / 16px 16px, linear-gradient(90deg, color-mix(in srgb, var(--accent) 22%, transparent) 1px, transparent 1px) 0 0 / 16px 16px",
  stripes: "repeating-linear-gradient(135deg, color-mix(in srgb, var(--accent) 18%, transparent) 0 6px, transparent 6px 14px)",
  waves:
    "radial-gradient(circle at 100% 50%, transparent 20%, color-mix(in srgb, var(--accent) 22%, transparent) 21% 34%, transparent 35% 54%, color-mix(in srgb, var(--accent) 22%, transparent) 55% 68%, transparent 69%) 0 0 / 28px 28px",
  rings: "repeating-radial-gradient(circle at 90% 50%, color-mix(in srgb, var(--accent) 26%, transparent) 0 1.5px, transparent 1.5px 12px)",
  glow: "radial-gradient(120% 140% at 100% 0%, color-mix(in srgb, var(--accent) 38%, transparent), transparent 60%)",
  aurora:
    "radial-gradient(60% 120% at 0% 100%, color-mix(in srgb, var(--accent) 30%, transparent), transparent 70%), radial-gradient(60% 120% at 100% 0%, color-mix(in srgb, #ec4899 26%, transparent), transparent 70%)",
};

export const COVER_IDS = Object.keys(COVERS);

/** Background for a drive card; undefined for no cover. */
export function coverStyle(id: string | null | undefined): CSSProperties | undefined {
  const bg = id ? COVERS[id] : undefined;
  return bg ? { background: bg } : undefined;
}
