"use client";

import { useQuery } from "@tanstack/react-query";
import { FolderOpen, Settings } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { useT } from "@/i18n";
import { api, ApiError, type VaultInfo } from "@/lib/api";
import { driveName, driveVars } from "@/lib/drive-style";
import { hasKept } from "@/lib/kept-keys";
import { useRouteParam } from "@/lib/route-param";
import { useSession } from "@/lib/session";
import { useStored } from "@/lib/storage";
import { useUnlocked } from "@/lib/unlocked";

import { DriveSize } from "../drive-size";
import { IncomingHandover } from "../handover";
import { RequireSession } from "../require-session";
import { Button, cn, Notice, Spinner } from "../ui";
import { FileBrowser, lastFolderKey } from "./browser";
import { DriveSettingsPanel } from "./settings";
import { SetupForm, UnlockForm } from "./unlock";

export type DriveTab = "files" | "settings";

export const vaultKey = (token: string, id: string) => ["vault", token, id];

function Tabs({ info, tab }: { info: VaultInfo; tab: DriveTab }) {
  const t = useT();
  const folder = useStored(lastFolderKey(info.token_id));
  const tabs = [
    { id: "files", href: `/drive/${info.token_id}${folder ? `?folder=${folder}` : ""}`, label: t("driveTabs.files"), icon: FolderOpen },
    { id: "settings", href: `/drive/${info.token_id}/settings`, label: t("driveTabs.settings"), icon: Settings },
  ] as const;
  return (
    <nav className="flex gap-1 rounded-xl border border-border bg-bg-subtle p-1">
      {tabs.map(({ id, href, label, icon: Icon }) => (
        <Link
          key={id}
          href={href}
          aria-current={tab === id ? "page" : undefined}
          className={cn(
            "flex h-8 items-center gap-2 rounded-lg px-3 text-sm transition-all",
            tab === id ? "bg-card font-medium text-fg shadow-sm" : "text-muted hover:text-fg",
          )}
        >
          <Icon className={cn("h-4 w-4", tab === id && "text-accent")} />
          {label}
        </Link>
      ))}
    </nav>
  );
}

/** Decides what a drive shows: setup, unlock, or the files; and hosts its tabs. */
function DriveGate({ token, tokenId, tab }: { token: string; tokenId: string; tab: DriveTab }) {
  const t = useT();
  const { address } = useSession();
  const store = useUnlocked();
  const unlocked = store.get(tokenId);
  const info = useQuery({ queryKey: vaultKey(token, tokenId), queryFn: () => api.vault(token, tokenId) });
  const key = useQuery({
    queryKey: ["key", token, tokenId],
    queryFn: () => api.getKey(token, tokenId),
    enabled: !!info.data?.initialized && !unlocked,
    staleTime: 0,
  });
  // "Stay unlocked on reload": bring the kept key back instead of asking for the passphrase.
  // Not for a drive that changed hands: its new owner makes a new key first.
  const kept = !!address && !unlocked && !!key.data && !key.data.needs_new_key && hasKept(address, tokenId);
  // A key sent by the previous owner replaces the passphrase form (kept behind a button).
  const handover = useQuery({
    queryKey: ["handover", token, tokenId],
    queryFn: () => api.incomingHandover(token, tokenId),
    enabled: !!info.data?.initialized && !unlocked,
  });
  const [usePassphrase, setUsePassphrase] = useState(false);
  const restore = useQuery({
    queryKey: ["restore", address, tokenId, key.data?.etag],
    queryFn: () => store.restore(tokenId, key.data!.etag, key.data!.keyring),
    enabled: kept,
    gcTime: 0,
    retry: false,
  });

  if (info.isLoading) return <Spinner className="mx-auto mt-24" />;
  if (info.error) {
    const status = info.error instanceof ApiError ? info.error.status : 0;
    const msg = status === 403 ? t("vault.notOwner") : status === 404 ? t("vault.notFound") : t("errors.network");
    return <Notice tone="danger">{msg}</Notice>;
  }
  const vault = info.data!;
  const name = driveName(vault, t);

  let body;
  if (tab === "settings") body = <DriveSettingsPanel token={token} info={vault} />;
  else if (unlocked) body = <FileBrowser token={token} info={vault} unlocked={unlocked} />;
  else if (!vault.initialized) body = <SetupForm token={token} tokenId={tokenId} name={name} />;
  else if (key.data && !(kept && restore.isPending))
    body = (
      <>
        <IncomingHandover
          token={token}
          tokenId={tokenId}
          keyBlob={key.data.key_blob}
          etag={key.data.etag}
          keyring={key.data.keyring}
          needsNewKey={key.data.needs_new_key}
        />
        {handover.data?.sealed && !usePassphrase ? (
          <div className="mt-4 text-center">
            <Button variant="ghost" size="sm" onClick={() => setUsePassphrase(true)}>
              {t("handover.usePassphrase")}
            </Button>
          </div>
        ) : (
          <UnlockForm
            token={token}
            tokenId={tokenId}
            name={name}
            keyBlob={key.data.key_blob}
            etag={key.data.etag}
            keyring={key.data.keyring}
            needsNewKey={key.data.needs_new_key}
            hasRecovery={!!vault.recovery_at}
          />
        )}
      </>
    );
  else if (key.error) body = <Notice tone="danger">{t("errors.network")}</Notice>;
  else body = <Spinner className="mx-auto mt-24" />;

  // The drive's colors recolor every accent inside it (buttons, tabs, progress, dialogs).
  return (
    <div style={driveVars(vault)}>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="font-mono text-xs text-muted">
            #{vault.token_id} · <DriveSize info={vault} />
          </p>
          <h1 className="truncate text-2xl font-semibold tracking-tight">{name}</h1>
        </div>
        <Tabs info={vault} tab={tab} />
      </header>
      <div key={tab} className="animate-fade-up">
        {body}
      </div>
    </div>
  );
}

export function DriveView({ tab = "files" }: { tab?: DriveTab }) {
  const tokenId = useRouteParam("tokenId", 1);
  return <RequireSession>{(token) => <DriveGate token={token} tokenId={tokenId} tab={tab} />}</RequireSession>;
}
