"use client";

import { useQuery } from "@tanstack/react-query";
import { FileUp, Loader2 } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { createPortal } from "react-dom";

import { useT } from "@/i18n";
import { api } from "@/lib/api";
import { DriveIcon } from "@/lib/drive-look";
import { driveName, driveVars } from "@/lib/drive-style";
import { entryLabel } from "@/lib/folder-upload";
import { formatBytes } from "@/lib/format";
import { useSession } from "@/lib/session";
import { chooseDrive, discardShared, useSharedFiles, watchSharedFiles } from "@/lib/shared-files";

import { vaultsKey } from "./drives";
import { useToast } from "./toast";
import { Button, Card, Spinner } from "./ui";

/**
 * Desktop app: files sent from the system (Explorer's "Upload to Etherdisk", "Send to")
 * wait in a card at the bottom-left. With several drives it asks which one; the drive then
 * opens (asking for its passphrase if locked) and the files upload into it.
 */
export function SharedFiles() {
  const t = useT();
  const toast = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const { token } = useSession();
  const { entries, reading, destination } = useSharedFiles();
  const waiting = entries.length > 0 || reading > 0;

  useEffect(() => watchSharedFiles((e) => toast({ text: t("sharedFiles.readError", { error: e instanceof Error ? e.message : String(e) }) })), [t, toast]);

  const vaults = useQuery({ queryKey: vaultsKey(token ?? ""), queryFn: () => api.vaults(token!), enabled: waiting && !!token && !destination });
  const pick = (id: string) => {
    chooseDrive(id);
    router.push(`/drive/${id}`);
  };
  // One drive: no question.
  const only = vaults.data?.length === 1 ? vaults.data[0].token_id : null;
  useEffect(() => {
    if (waiting && only && !destination) pick(only);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, only, destination]);
  // Not signed in: the drives page asks for the wallet.
  useEffect(() => {
    if (waiting && !token && !pathname.startsWith("/drive")) router.push("/drive");
  }, [waiting, token, pathname, router]);

  if (!waiting || typeof document === "undefined") return null;
  const names = [...new Set(entries.map((e) => e.dirs[0] ?? entryLabel(e)))];
  const chosen = destination && vaults.data?.find((v) => v.token_id === destination);
  return createPortal(
    <div className="fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] left-4 z-40 w-[min(22rem,calc(100vw-2rem))] animate-slide-in">
      <Card className="space-y-3 p-4 shadow-2xl">
        <div className="flex items-center gap-2 text-sm font-medium">
          {reading ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-accent" /> : <FileUp className="h-4 w-4 shrink-0 text-accent" />}
          <span className="min-w-0 flex-1 truncate">{reading ? t("sharedFiles.reading", { n: reading }) : t("sharedFiles.title", { n: names.length })}</span>
        </div>
        {names.length > 0 && (
          <p className="truncate text-xs text-muted" title={names.join(", ")}>
            {names.slice(0, 3).join(", ")}
            {names.length > 3 && ` ${t("sharedFiles.more", { n: names.length - 3 })}`}
          </p>
        )}
        {destination ? (
          <p className="text-xs text-muted">{t("sharedFiles.afterUnlock", { name: chosen ? driveName(chosen, t) : t("drives.drive", { id: destination }) })}</p>
        ) : !token ? (
          <p className="text-xs text-muted">{t("sharedFiles.signIn")}</p>
        ) : vaults.isLoading ? (
          <Spinner className="mx-auto h-5 w-5" />
        ) : vaults.data?.length ? (
          <div className="space-y-1">
            <p className="text-xs text-muted">{t("sharedFiles.pick")}</p>
            <ul className="max-h-60 space-y-1 overflow-auto">
              {vaults.data.map((v) => (
                <li key={v.token_id}>
                  <button
                    type="button"
                    style={driveVars(v)}
                    onClick={() => pick(v.token_id)}
                    className="flex w-full items-center gap-3 rounded-lg border border-border px-3 py-2 text-left text-sm hover:bg-bg-subtle"
                  >
                    <DriveIcon id={v.icon} className="h-4 w-4 shrink-0 text-[var(--drive-stroke)]" />
                    <span className="min-w-0 flex-1 truncate">{driveName(v, t)}</span>
                    <span className="shrink-0 text-xs text-muted tabular-nums">{formatBytes(v.capacity_bytes)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-xs text-muted">{t("sharedFiles.noDrives")}</p>
        )}
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" onClick={discardShared}>
            {t("sharedFiles.discard")}
          </Button>
        </div>
      </Card>
    </div>,
    document.body,
  );
}
