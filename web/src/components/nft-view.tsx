"use client";

import { useQuery } from "@tanstack/react-query";
import { CircleOff, FileCheck2, Tag } from "lucide-react";

import { useT } from "@/i18n";
import { api, ApiError } from "@/lib/api";
import { formatBytes, formatCapacity, formatDate } from "@/lib/format";
import { useRouteParam } from "@/lib/route-param";

import { DriveArt } from "./drive-art";
import { Card, Notice, Progress, Spinner } from "./ui";

const GIB = 1024 ** 3;

/**
 * A drive NFT's public page: no wallet needed. While its owner has it up for sale, it says
 * whether the buyer gets the files (the drive key) and how much of the drive is used.
 */
export function NftView() {
  const t = useT();
  const id = useRouteParam("tokenId", 1);
  const nft = useQuery({ queryKey: ["nft", id], queryFn: () => api.nft(id), retry: false, refetchOnWindowFocus: true });

  if (nft.isLoading) return <Spinner className="mx-auto mt-24" />;
  if (!nft.data) {
    const missing = nft.error instanceof ApiError && nft.error.status === 404;
    return (
      <div className="mx-auto max-w-md">
        <Notice tone="danger">{missing ? t("sale.notFound") : t("common.error")}</Notice>
      </div>
    );
  }
  const { capacity_bytes: capacity, sale } = nft.data;
  const gb = Math.round(capacity / GIB);
  return (
    <div className="mx-auto grid max-w-4xl items-start gap-10 md:grid-cols-[18rem_1fr]">
      <DriveArt capacityGb={gb} tokenId={Number(id)} className="mx-auto w-full max-w-72" />
      <div className="flex flex-col gap-5">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("sale.nftTitle", { id })}</h1>
          <p className="mt-1 text-muted">{formatCapacity(gb)}</p>
        </div>
        {!sale ? (
          <Card className="flex items-start gap-3 p-5 text-sm text-muted">
            <CircleOff className="mt-0.5 h-4 w-4 shrink-0" />
            {t("sale.notForSale")}
          </Card>
        ) : (
          <Card className="flex flex-col gap-5 p-5">
            <span className="inline-flex w-fit items-center gap-1 rounded-full bg-accent/10 px-2.5 py-0.5 text-xs font-medium text-accent">
              <Tag className="h-3.5 w-3.5" />
              {t("sale.listedSince", { date: formatDate(sale.since) })}
            </span>
            <div className="flex items-start gap-3">
              {sale.with_key ? <FileCheck2 className="mt-0.5 h-5 w-5 shrink-0 text-success" /> : <CircleOff className="mt-0.5 h-5 w-5 shrink-0 text-muted" />}
              <div>
                <p className="font-medium">{sale.with_key ? t("sale.buyerGetsFiles") : t("sale.buyerGetsEmpty")}</p>
                <p className="mt-1 text-sm text-muted">{sale.with_key ? t("sale.buyerGetsFilesText") : t("sale.buyerGetsEmptyText")}</p>
              </div>
            </div>
            <div>
              <p className="mb-2 text-sm">{t("sale.used", { used: formatBytes(sale.used_bytes), capacity: formatBytes(capacity) })}</p>
              <Progress value={capacity ? sale.used_bytes / capacity : 0} />
              {!sale.initialized && <p className="mt-2 text-sm text-muted">{t("sale.neverSetUp")}</p>}
            </div>
            <p className="text-xs text-muted">
              {t("sale.checked")} {t("sale.endsOnTransfer")}
            </p>
          </Card>
        )}
      </div>
    </div>
  );
}
