"use client";

import { useQuery } from "@tanstack/react-query";
import { Search, X } from "lucide-react";
import { useMemo } from "react";

import { useT } from "@/i18n";
import { api } from "@/lib/api";
import { itemName, openItem, type Item } from "@/lib/meta";

import { cn, Spinner } from "../ui";
import type { DriveCtx } from "./dialogs";

export const searchKey = (ctx: DriveCtx) => ["objects", ctx.token, ctx.tokenId, "__all"];

/** Accent- and case-insensitive form for matching ("Café" ~ "cafe"). */
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();

export interface Hit {
  item: Item;
  /** "Photos / 2026" — the folder the hit is in ("" at the root). */
  path: string;
}

/**
 * Searches names across the whole drive. Names are encrypted on the server, so the
 * index is every live object, decrypted in the browser once and kept in the query cache.
 */
export function useSearch(ctx: DriveCtx, query: string): { hits: Hit[]; loading: boolean } {
  const index = useQuery({
    queryKey: searchKey(ctx),
    queryFn: () => api.all(ctx.token, ctx.tokenId),
    enabled: query.length > 0,
    staleTime: 60_000,
    select: (rows) => rows.map((r) => openItem(ctx.vault, r)),
  });

  const hits = useMemo(() => {
    const q = fold(query.trim());
    if (!q || !index.data) return [];
    const byId = new Map(index.data.map((i) => [i.row.id, i]));
    const pathOf = (item: Item) => {
      const parts: string[] = [];
      for (let p = item.row.parent_id; p; p = byId.get(p)?.row.parent_id ?? null) parts.unshift(byId.has(p) ? itemName(byId.get(p)!) : "…");
      return parts.join(" / ");
    };
    const terms = q.split(/\s+/);
    return index.data
      .filter((i) => i.meta && terms.every((term) => fold(itemName(i)).includes(term)))
      .sort((a, b) => (a.row.kind !== b.row.kind ? (a.row.kind === "folder" ? -1 : 1) : itemName(a).localeCompare(itemName(b))))
      .slice(0, 200)
      .map((item) => ({ item, path: pathOf(item) }));
  }, [index.data, query]);

  return { hits, loading: index.isLoading && query.length > 0 };
}

export function SearchBox({ value, onChange, loading }: { value: string; onChange: (v: string) => void; loading: boolean }) {
  const t = useT();
  return (
    <div className="relative w-full sm:w-64">
      <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted" />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onChange("")}
        placeholder={t("files.search")}
        aria-label={t("files.search")}
        className={cn(
          "h-9 w-full rounded-lg border border-border bg-card pr-9 pl-9 text-sm outline-none transition placeholder:text-muted focus:border-accent",
          "[&::-webkit-search-cancel-button]:hidden",
        )}
      />
      {loading ? (
        <Spinner className="absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2" />
      ) : (
        value && (
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={() => onChange("")}
            className="absolute top-1/2 right-2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded text-muted hover:text-fg"
          >
            <X className="h-4 w-4" />
          </button>
        )
      )}
    </div>
  );
}
