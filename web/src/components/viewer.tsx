"use client";

import { Download } from "lucide-react";
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

/** Preview of an image, video, audio, PDF or text file, decrypted on the fly. */
export function Viewer({ source, onClose }: { source: StreamSource | null; onClose: () => void }) {
  const t = useT();
  // A media error is usually the browser having restarted the worker (streams live in
  // memory): remount the preview once, which registers the stream again.
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const onFailed = () => (attempt === 0 ? setAttempt(1) : setFailed(true));
  const close = () => {
    setAttempt(0);
    setFailed(false);
    onClose();
  };

  return (
    <Dialog open={!!source} onClose={close} title={source?.name ?? ""} wide>
      <div className="flex flex-col gap-4">
        <div className="grid min-h-48 place-items-center">
          {source &&
            (failed ? (
              <Notice tone="danger">{t("files.decryptFailed")}</Notice>
            ) : (
              <Preview key={attempt} source={source} onFailed={onFailed} />
            ))}
        </div>
        <div className="flex justify-end">
          <Button variant="primary" onClick={() => source && downloadFile(source)}>
            <Download className="h-4 w-4" />
            {t("files.download")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
