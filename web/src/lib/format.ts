const UNITS = ["B", "KB", "MB", "GB", "TB"];

/** Binary units, matching how drive capacity is counted (1 GB = 2^30 bytes). */
export function formatBytes(n: number): string {
  let i = 0;
  while (n >= 1024 && i < UNITS.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)} ${UNITS[i]}`;
}

export function formatDate(unixSecondsOrMs: number): string {
  const ms = unixSecondsOrMs < 1e12 ? unixSecondsOrMs * 1000 : unixSecondsOrMs;
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const EXT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
};

/** Browsers leave File.type empty for many extensions. */
export function guessType(name: string, type: string): string {
  if (type) return type;
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TYPES[ext] ?? "application/octet-stream";
}

const TEXT_EXT =
  /\.(txt|md|markdown|json|csv|tsv|log|xml|ya?ml|toml|ini|env|rs|ts|tsx|js|jsx|mjs|py|go|java|kt|c|h|cpp|hpp|cs|rb|php|sh|ps1|sql|css|scss|html|sol)$/i;

export type ViewKind = "image" | "video" | "audio" | "pdf" | "text" | null;

export function viewKind(name: string, type: string): ViewKind {
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (type === "application/pdf") return "pdf";
  if (type.startsWith("text/") || type === "application/json" || TEXT_EXT.test(name)) return "text";
  return null;
}
