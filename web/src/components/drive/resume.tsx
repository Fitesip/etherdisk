"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import { useRef } from "react";

import { useT } from "@/i18n";
import { api, type PendingUpload } from "@/lib/api";
import { isFileMeta, openItem } from "@/lib/meta";
import type { ResumeTarget } from "@/lib/upload";

import { useToast } from "../toast";
import { Button } from "../ui";
import type { DriveCtx } from "./dialogs";

interface Interrupted {
  target: ResumeTarget;
  parentId: string | null;
}

/**
 * Offers to continue uploads that stopped (tab closed, reload, network). The browser
 * can't reopen a file by itself, so the user picks the same files again; they are
 * matched by name, size and modification time, and verified before resuming.
 */
export function ResumeBanner({
  ctx,
  onResume,
  active,
}: {
  ctx: DriveCtx;
  onResume: (file: File, target: ResumeTarget, parentId: string | null) => void;
  /** Uploads already running in this tab. */
  active: ReadonlySet<string>;
}) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const pending = useQuery({
    queryKey: ["objects", ctx.token, ctx.tokenId, "__uploads"],
    queryFn: () => api.uploads(ctx.token, ctx.tokenId),
    staleTime: 30_000,
    select: (rows: PendingUpload[]) =>
      rows.flatMap((r): Interrupted[] => {
        const { meta } = openItem(ctx.vault, r);
        if (!isFileMeta(meta)) return [];
        return [
          {
            target: { id: r.id, meta, encSize: r.size, received: r.received, hadThumbnail: r.thumb_size !== null },
            parentId: r.parent_id,
          },
        ];
      }),
  });

  const waiting = (pending.data ?? []).filter((p) => !active.has(p.target.id));
  if (!waiting.length) return null;

  function pick(files: File[]) {
    for (const file of files) {
      const match = waiting.find(
        (p) => p.target.meta.name === file.name && p.target.meta.size === file.size && p.target.meta.mtime === file.lastModified,
      );
      if (match) onResume(file, match.target, match.parentId);
      else toast({ text: t("files.resumeMismatch", { name: file.name }) });
    }
  }

  async function discard() {
    for (const p of waiting) await api.remove(ctx.token, ctx.tokenId, p.target.id).catch(() => {});
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["objects", ctx.token, ctx.tokenId, "__uploads"] }),
      qc.invalidateQueries({ queryKey: ["vault", ctx.token, ctx.tokenId] }),
    ]);
  }

  const names = waiting.map((p) => p.target.meta.name);
  return (
    <div className="flex animate-fade-up flex-wrap items-center gap-3 rounded-xl border border-accent/40 bg-accent-soft px-4 py-3">
      <RotateCcw className="h-5 w-5 shrink-0 text-accent" />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium">
          {t("files.resumeTitle")} · {waiting.length}
        </p>
        <p className="truncate text-muted" title={names.join(", ")}>
          {t("files.resumeText", { names: names.slice(0, 3).join(", ") + (names.length > 3 ? ", …" : "") })}
        </p>
      </div>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          pick(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
      <Button size="sm" variant="primary" onClick={() => input.current?.click()}>
        {t("files.resumeAction")}
      </Button>
      <Button size="sm" variant="ghost" onClick={discard}>
        {t("files.discard")}
      </Button>
    </div>
  );
}
