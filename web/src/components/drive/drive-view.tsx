"use client";

import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";

import { useT } from "@/i18n";
import { api, ApiError } from "@/lib/api";
import { driveName, driveVars } from "@/lib/drive-style";
import { useUnlocked } from "@/lib/unlocked";

import { RequireSession } from "../require-session";
import { Notice, Spinner } from "../ui";
import { FileBrowser } from "./browser";
import { SetupForm, UnlockForm } from "./unlock";

export const vaultKey = (token: string, id: string) => ["vault", token, id];

/** Decides what a drive shows: setup, unlock, or the files. */
function DriveGate({ token, tokenId }: { token: string; tokenId: string }) {
  const t = useT();
  const unlocked = useUnlocked().get(tokenId);
  const info = useQuery({ queryKey: vaultKey(token, tokenId), queryFn: () => api.vault(token, tokenId) });
  const key = useQuery({
    queryKey: ["key", token, tokenId],
    queryFn: () => api.getKey(token, tokenId),
    enabled: !!info.data?.initialized && !unlocked,
    staleTime: 0,
  });

  if (info.isLoading) return <Spinner className="mx-auto mt-24" />;
  if (info.error) {
    const status = info.error instanceof ApiError ? info.error.status : 0;
    const msg = status === 403 ? t("vault.notOwner") : status === 404 ? t("vault.notFound") : t("errors.network");
    return <Notice tone="danger">{msg}</Notice>;
  }
  const vault = info.data!;
  const name = driveName(vault, t);
  // The drive's colors recolor every accent inside it (buttons, progress, dialogs).
  return (
    <div style={driveVars(vault)}>
      {unlocked ? (
        <FileBrowser token={token} info={vault} unlocked={unlocked} />
      ) : !vault.initialized ? (
        <SetupForm token={token} tokenId={tokenId} name={name} />
      ) : key.data ? (
        <UnlockForm token={token} tokenId={tokenId} name={name} keyBlob={key.data.key_blob} etag={key.data.etag} />
      ) : key.error ? (
        <Notice tone="danger">{t("errors.network")}</Notice>
      ) : (
        <Spinner className="mx-auto mt-24" />
      )}
    </div>
  );
}

export function DriveView() {
  const { tokenId } = useParams<{ tokenId: string }>();
  return <RequireSession>{(token) => <DriveGate token={token} tokenId={tokenId} />}</RequireSession>;
}
