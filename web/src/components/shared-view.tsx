"use client";

import { Download, File as FileIcon, Folder } from "lucide-react";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { useT } from "@/i18n";
import { api } from "@/lib/api";
import { fromB64, loadCrypto } from "@/lib/crypto";
import { formatBytes, viewKind } from "@/lib/format";
import { openManifest, type Manifest, type ManifestFile } from "@/lib/share";
import { downloadFile, shareSource, type StreamSource } from "@/lib/stream";
import { useThumbnail } from "@/lib/thumbs";

import { Logo } from "./header";
import { Button, Card, Notice, Spinner } from "./ui";
import { Viewer } from "./viewer";

function Row({ shareId, file, onOpen }: { shareId: string; file: ManifestFile; onOpen: (s: StreamSource) => void }) {
  const t = useT();
  const src = shareSource(shareId, file);
  const thumb = useThumbnail(file.thumbKey ? `share:${shareId}:${file.id}` : null, async () => ({
    data: await api.shareThumbnail(shareId, file.id),
    key: fromB64(file.thumbKey!),
  }));
  return (
    <li className="flex items-center gap-3 px-4 py-2 hover:bg-bg-subtle">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
        onClick={() => (viewKind(file.name, file.type) ? onOpen(src) : downloadFile(src))}
      >
        <div className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-md bg-bg-subtle">
          {/* eslint-disable-next-line @next/next/no-img-element -- decrypted blob URL */}
          {thumb ? <img src={thumb} alt="" className="h-full w-full object-cover" /> : <FileIcon className="h-5 w-5 text-muted" />}
        </div>
        <span className="min-w-0 truncate text-sm">
          {file.path && <span className="text-muted">{file.path}</span>}
          {file.name}
        </span>
      </button>
      <span className="hidden text-sm text-muted tabular-nums sm:block">{formatBytes(file.size)}</span>
      <Button size="icon" variant="ghost" aria-label={t("files.download")} onClick={() => downloadFile(src)}>
        <Download className="h-4 w-4" />
      </Button>
    </li>
  );
}

export function SharedView() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<{ manifest?: Manifest; error?: string } | null>(null);
  const [viewing, setViewing] = useState<StreamSource | null>(null);

  useEffect(() => {
    // The key is in the fragment, which only exists in the browser.
    const key = window.location.hash.slice(1);
    let live = true;
    (async () => {
      if (!key) return setState({ error: t("share.missingKey") });
      try {
        await loadCrypto();
        const { manifest } = await api.openShare(id);
        const m = openManifest(fromB64(key), manifest);
        if (live) setState({ manifest: m });
      } catch {
        if (live) setState({ error: t("share.invalid") });
      }
    })();
    return () => {
      live = false;
    };
  }, [id, t]);

  const manifest = state?.manifest;
  return (
    <div className="flex flex-1 flex-col">
      <header className="mx-auto flex h-16 w-full max-w-4xl items-center px-4">
        <Logo />
      </header>
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 pb-16">
        {!state ? (
          <Spinner className="mx-auto mt-24" />
        ) : state.error ? (
          <Notice tone="danger">{state.error}</Notice>
        ) : (
          manifest && (
            <>
              <p className="text-sm text-muted">{t("share.pageTitle")}</p>
              <h1 className="mt-1 flex items-center gap-2 text-2xl font-semibold tracking-tight">
                {manifest.kind === "folder" && <Folder className="h-6 w-6 text-accent" />}
                {manifest.name}
              </h1>
              <Card className="mt-6 overflow-hidden">
                <ul className="divide-y divide-border">
                  {manifest.files.map((f) => (
                    <Row key={f.id} shareId={id} file={f} onOpen={setViewing} />
                  ))}
                </ul>
              </Card>
            </>
          )
        )}
      </main>
      <Viewer source={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}
