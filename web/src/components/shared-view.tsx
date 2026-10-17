"use client";

import { Download, File as FileIcon, Folder, KeyRound } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { useT } from "@/i18n";
import { api } from "@/lib/api";
import { fromB64, loadCrypto, nextFrame } from "@/lib/crypto";
import { formatBytes, viewKind } from "@/lib/format";
import { useRouteParam } from "@/lib/route-param";
import { openManifest, parseFragment, type Manifest, type ManifestFile } from "@/lib/share";
import { downloadFile, downloadZip, shareSource } from "@/lib/stream";
import { useThumbnail } from "@/lib/thumbs";

import { Logo } from "./header";
import { useToast } from "./toast";
import { Button, Card, Notice, PasswordInput, Spinner } from "./ui";
import { Viewer, type Gallery } from "./viewer";

function Row({ shareId, file, onOpen, viewOnly }: { shareId: string; file: ManifestFile; onOpen: () => void; viewOnly?: boolean }) {
  const t = useT();
  const thumb = useThumbnail(file.thumbKey ? `share:${shareId}:${file.id}` : null, async () => ({
    data: await api.shareThumbnail(shareId, file.id),
    key: fromB64(file.thumbKey!),
  }));
  const viewable = !!viewKind(file.name, file.type);
  return (
    <li className="flex items-center gap-3 px-4 py-2 hover:bg-bg-subtle">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:cursor-default"
        disabled={!viewable && viewOnly}
        onClick={() => (viewable ? onOpen() : downloadFile(shareSource(shareId, file)))}
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
      {!viewOnly && (
        <Button size="icon" variant="ghost" aria-label={t("files.download")} onClick={() => downloadFile(shareSource(shareId, file))}>
          <Download className="h-4 w-4" />
        </Button>
      )}
    </li>
  );
}

type State =
  | { phase: "loading" }
  | { phase: "error"; error: string }
  | { phase: "password"; key: Uint8Array; sealed: string }
  | { phase: "open"; manifest: Manifest };

export function SharedView() {
  const t = useT();
  const toast = useToast();
  const id = useRouteParam("id", 1);
  const [state, setState] = useState<State>({ phase: "loading" });
  const [gallery, setGallery] = useState<Gallery | null>(null);
  const [password, setPassword] = useState("");
  const [checking, setChecking] = useState(false);
  const [wrong, setWrong] = useState(false);

  useEffect(() => {
    // The key is in the fragment, which only exists in the browser.
    const fragment = parseFragment(window.location.hash.slice(1));
    let live = true;
    (async () => {
      if (!fragment.key) return setState({ phase: "error", error: t("share.missingKey") });
      try {
        await loadCrypto();
        const { manifest } = await api.openShare(id);
        const key = fromB64(fragment.key);
        if (fragment.password) {
          if (live) setState({ phase: "password", key, sealed: manifest });
          return;
        }
        const m = await openManifest(key, manifest);
        if (live) setState({ phase: "open", manifest: m });
      } catch {
        if (live) setState({ phase: "error", error: t("share.invalid") });
      }
    })();
    return () => {
      live = false;
    };
  }, [id, t]);

  async function unlock(e: FormEvent) {
    e.preventDefault();
    if (state.phase !== "password" || !password) return;
    setChecking(true);
    setWrong(false);
    await nextFrame();
    try {
      setState({ phase: "open", manifest: await openManifest(state.key, state.sealed, password) });
    } catch {
      setWrong(true);
    } finally {
      setChecking(false);
    }
  }

  const manifest = state.phase === "open" ? state.manifest : null;
  const viewable = manifest?.files.filter((f) => viewKind(f.name, f.type)) ?? [];
  const openAt = (f: ManifestFile) => setGallery({ sources: viewable.map((v) => shareSource(id, v)), index: viewable.indexOf(f) });

  async function downloadAll() {
    if (!manifest) return;
    toast({ text: t("files.preparingZip") });
    try {
      await downloadZip(
        `${manifest.name || "files"}.zip`,
        manifest.files.map((f) => ({ path: f.path + f.name, size: f.size, mtime: Date.now(), src: shareSource(id, f) })),
      );
    } catch (e) {
      toast({ text: e instanceof Error && e.message === "no-worker" ? t("files.zipUnavailable") : t("common.error") });
    }
  }

  return (
    <div className="flex flex-1 flex-col">
      <header className="mx-auto flex h-16 w-full max-w-4xl items-center px-4">
        <Logo />
      </header>
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 pb-16">
        {state.phase === "loading" ? (
          <Spinner className="mx-auto mt-24" />
        ) : state.phase === "error" ? (
          <Notice tone="danger">{state.error}</Notice>
        ) : state.phase === "password" ? (
          <Card className="mx-auto mt-10 max-w-sm animate-fade-up p-8">
            <div className="mb-4 grid h-12 w-12 place-items-center rounded-full bg-accent-soft text-accent">
              <KeyRound className="h-6 w-6" />
            </div>
            <p className="text-sm text-muted">{t("share.passwordPrompt")}</p>
            <form onSubmit={unlock} className="mt-5 flex flex-col gap-3">
              <PasswordInput autoFocus value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t("share.passwordPlaceholder")} />
              {wrong && <p className="text-xs text-danger">{t("share.wrongPassword")}</p>}
              <Button type="submit" variant="primary" loading={checking} disabled={!password}>
                {t("share.open")}
              </Button>
            </form>
          </Card>
        ) : (
          manifest && (
            <div className="animate-fade-up">
              <p className="text-sm text-muted">{t("share.pageTitle")}</p>
              <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
                <h1 className="flex min-w-0 items-center gap-2 text-2xl font-semibold tracking-tight">
                  {manifest.kind === "folder" && <Folder className="h-6 w-6 shrink-0 text-accent" />}
                  <span className="truncate">{manifest.name}</span>
                </h1>
                {!manifest.viewOnly && manifest.files.length > 1 && (
                  <Button onClick={downloadAll}>
                    <Download className="h-4 w-4" />
                    {t("files.downloadZip")}
                  </Button>
                )}
              </div>
              <Card className="mt-6 overflow-hidden">
                <ul className="divide-y divide-border">
                  {manifest.files.map((f) => (
                    <Row key={f.id} shareId={id} file={f} onOpen={() => openAt(f)} viewOnly={manifest.viewOnly} />
                  ))}
                </ul>
              </Card>
            </div>
          )
        )}
      </main>
      <Viewer
        gallery={gallery}
        onIndex={(index) => setGallery((g) => g && { ...g, index })}
        onClose={() => setGallery(null)}
        viewOnly={manifest?.viewOnly}
      />
    </div>
  );
}
