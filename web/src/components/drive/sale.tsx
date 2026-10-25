"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Tag } from "lucide-react";
import { useState } from "react";

import { useT } from "@/i18n";
import { api, type VaultInfo } from "@/lib/api";
import { siteUrl } from "@/lib/config";
import { formatDate } from "@/lib/format";

import { useToast } from "../toast";
import { Button, cn, Input } from "../ui";
import { CopyButton } from "./dialogs";

/** The public page of a drive NFT: what buyers see while it is for sale. */
export const nftPageUrl = (tokenId: string) => `${siteUrl()}/nft/${tokenId}`;

/**
 * Selling the drive (on any marketplace): the owner tells buyers whether the drive's key
 * comes with it, and the public page shows that with how much is used. The NFT itself
 * doesn't change; any transfer ends the listing.
 */
export function SaleSettings({ token, info }: { token: string; info: VaultInfo }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const [withKey, setWithKey] = useState(info.initialized);
  const [busy, setBusy] = useState(false);
  const run = (f: () => Promise<unknown>) => async () => {
    setBusy(true);
    try {
      await f();
      // The drive's page and the drive list both show it.
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["vault", token, info.token_id] }),
        qc.invalidateQueries({ queryKey: ["vaults", token] }),
      ]);
    } catch (e) {
      toast({ text: e instanceof Error && e.message ? e.message : t("common.error") });
    } finally {
      setBusy(false);
    }
  };
  const id = info.token_id;

  if (info.sale) {
    const url = nftPageUrl(id);
    return (
      <div className="flex flex-col gap-4">
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2.5 py-0.5 text-xs font-medium text-accent">
            <Tag className="h-3.5 w-3.5" />
            {t("sale.forSale")}
          </span>
          <span className="text-muted">
            {info.sale.with_key ? t("sale.withKeyShort") : t("sale.withoutKeyShort")} · {t("sale.since", { date: formatDate(info.sale.since) })}
          </span>
        </p>
        <div>
          <p className="mb-2 text-sm text-muted">{t("sale.pageText")}</p>
          <div className="flex gap-2">
            <Input readOnly value={url} aria-label={t("sale.page")} onFocus={(e) => e.currentTarget.select()} />
            <CopyButton text={url} />
            <a href={url} target="_blank" rel="noreferrer" aria-label={t("sale.open")} className="inline-flex h-8 shrink-0 items-center rounded-lg border border-border px-2.5 hover:bg-bg-subtle">
              <ExternalLink className="h-4 w-4" />
            </a>
          </div>
        </div>
        {info.sale.with_key && <p className="text-sm text-muted">{t("sale.keyPromise")}</p>}
        <div>
          <Button size="sm" loading={busy} onClick={run(() => api.endSale(token, id))}>
            {t("sale.end")}
          </Button>
        </div>
      </div>
    );
  }

  const choice = (value: boolean, title: string, text: string, disabled = false) => (
    <button
      type="button"
      role="radio"
      aria-checked={withKey === value}
      disabled={disabled}
      onClick={() => setWithKey(value)}
      className={cn(
        "flex flex-1 flex-col gap-1 rounded-lg border p-3 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        withKey === value ? "border-accent bg-accent/5" : "border-border hover:bg-bg-subtle",
      )}
    >
      <span className="font-medium">{title}</span>
      <span className="text-muted">{text}</span>
    </button>
  );
  return (
    <div className="flex flex-col gap-4">
      <div role="radiogroup" aria-label={t("sale.title")} className="flex flex-col gap-2 sm:flex-row">
        {choice(true, t("sale.withKey"), info.initialized ? t("sale.withKeyText") : t("sale.notSetUp"), !info.initialized)}
        {choice(false, t("sale.withoutKey"), t("sale.withoutKeyText"))}
      </div>
      <div>
        <Button size="sm" variant="primary" loading={busy} onClick={run(() => api.setSale(token, id, withKey && info.initialized))}>
          <Tag className="h-4 w-4" />
          {t("sale.start")}
        </Button>
      </div>
    </div>
  );
}
