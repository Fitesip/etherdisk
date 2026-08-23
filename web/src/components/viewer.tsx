"use client";

import { ChevronLeft, ChevronRight, Download } from "lucide-react";
import { useEffect, useState } from "react";

import { useT } from "@/i18n";
import { touchActivity } from "@/lib/activity";
import { formatBytes, viewKind } from "@/lib/format";
import { downloadFile, openUrl, type StreamSource } from "@/lib/stream";

import { Button, Dialog, Notice, Spinner } from "./ui";

const TEXT_LIMIT = 1024 * 1024;

function TextView({ url }: { url: string }) {
  const t = useT();
  const [text, setText] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  useEffect(() => {
    let live = true;
    fetch(url, { headers: { Range: `bytes=0-${TEXT_LIMIT - 1}` } })
      .then(async (r) => {
        const total = Number(r.headers.get("Content-Range")?.split("/")[1] ?? r.headers.get("Content-Length") ?? 0);
        const body = await r.text();
        if (!live) return;
        setTruncated(total > TEXT_LIMIT || body.length > TEXT_LIMIT);
        setText(body.slice(0, TEXT_LIMIT));
      })
      .catch(() => live && setText(""));
    return () => {
      live = false;
    };
  }, [url]);
  if (text === null) return <Spinner />;
  return (
    <>
      {truncated && <p className="mb-2 text-xs text-muted">{t("files.textTruncated", { size: formatBytes(TEXT_LIMIT) })}</p>}
      <pre className="max-h-[65vh] overflow-auto rounded-lg bg-bg-subtle p-4 font-mono text-xs whitespace-pre-wrap">{text}</pre>
    </>
  );
}

function Preview({ source, onFailed }: { source: StreamSource; onFailed: () => void }) {
  const t = useT();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const kind = viewKind(source.name, source.type);

  useEffect(() => {
    if (!kind) return;
    let live = true;
    let blobUrl: string | null = null;
    openUrl(source)
      .then((r) => {
        if (r.blob) blobUrl = r.url;
        if (live) setUrl(r.url);
        else if (blobUrl) URL.revokeObjectURL(blobUrl);
      })
      .catch(() => live && setError(true));
    return () => {
      live = false;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [source, kind]);

  if (!kind) return <p className="text-sm text-muted">{t("files.noPreview")}</p>;
  if (error) return <Notice tone="danger">{t("files.decryptFailed")}</Notice>;
  if (!url) return <Spinner />;
  switch (kind) {
    case "image":
      // eslint-disable-next-line @next/next/no-img-element -- decrypted on the fly, not optimizable
      return <img src={url} alt={source.name} className="max-h-[70vh] max-w-full rounded-lg object-contain" onError={onFailed} />;
    case "video":
      return <video src={url} controls autoPlay className="max-h-[70vh] w-full rounded-lg bg-black" onError={onFailed} onTimeUpdate={touchActivity} />;
    case "audio":
      return <audio src={url} controls autoPlay className="w-full" onError={onFailed} onTimeUpdate={touchActivity} />;
    case "pdf":
      return <iframe src={url} title={source.name} className="h-[70vh] w-full rounded-lg border border-border" />;
    case "text":
      return (
        <div className="w-full">
          <TextView url={url} />
        </div>
      );
  }
}

export interface Gallery {
  /** Files to step through; `index` is the one shown. */
  sources: StreamSource[];
  index: number;
}

/**
 * Preview of an image, video, audio, PDF or text file, decrypted on the fly.
 * With several sources it is a gallery: arrows (and ←/→) move between them.
 */
export function Viewer({
  gallery,
  onIndex,
  onClose,
  viewOnly,
}: {
  gallery: Gallery | null;
  onIndex: (index: number) => void;
  onClose: () => void;
  /** Hide the download button (shared "preview only" links). */
  viewOnly?: boolean;
}) {
  const t = useT();
  const source = gallery ? gallery.sources[gallery.index] : null;
  const count = gallery?.sources.length ?? 0;
  const index = gallery?.index ?? 0;
  // A media error is usually the browser having restarted the worker (streams live in
  // memory): remount the preview once, which registers the stream again.
  const [retry, setRetry] = useState<{ index: number; attempt: number; failed: boolean }>({ index: -1, attempt: 0, failed: false });
  const state = retry.index === index ? retry : { index, attempt: 0, failed: false };
  const onFailed = () => setRetry(state.attempt === 0 ? { index, attempt: 1, failed: false } : { ...state, failed: true });
  const go = (delta: number) => count > 1 && onIndex((index + delta + count) % count);

  useEffect(() => {
    if (!gallery || count < 2) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "ArrowRight") onIndex((gallery.index + 1) % count);
      if (e.key === "ArrowLeft") onIndex((gallery.index - 1 + count) % count);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [gallery, count, onIndex]);

  return (
    <Dialog open={!!source} onClose={onClose} title={source?.name ?? ""} wide>
      <div className="flex flex-col gap-4">
        <div className="relative grid min-h-48 place-items-center">
          {source &&
            (state.failed ? (
              <Notice tone="danger">{t("files.decryptFailed")}</Notice>
            ) : (
              <Preview key={`${index}:${state.attempt}`} source={source} onFailed={onFailed} />
            ))}
          {count > 1 && (
            <>
              <button
                type="button"
                aria-label={t("files.previous")}
                onClick={() => go(-1)}
                className="absolute top-1/2 left-0 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full border border-border bg-card/80 shadow backdrop-blur transition hover:bg-card"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
              <button
                type="button"
                aria-label={t("files.next")}
                onClick={() => go(1)}
                className="absolute top-1/2 right-0 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full border border-border bg-card/80 shadow backdrop-blur transition hover:bg-card"
              >
                <ChevronRight className="h-5 w-5" />
              </button>
            </>
          )}
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-muted tabular-nums">{count > 1 && t("files.position", { i: index + 1, n: count })}</span>
          {!viewOnly && (
            <Button variant="primary" onClick={() => source && downloadFile(source)}>
              <Download className="h-4 w-4" />
              {t("files.download")}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
