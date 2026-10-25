import { Suspense } from "react";

import { NftView } from "@/components/nft-view";
import { Spinner } from "@/components/ui";

// The page of a drive NFT, for buyers: whether it is for sale and with what.
export default function NftPage() {
  return (
    <Suspense fallback={<Spinner className="mx-auto mt-24" />}>
      <NftView />
    </Suspense>
  );
}

// The static export (the desktop app) has one page, for `_`, served for every id (lib/route-param.ts).
export function generateStaticParams() {
  return [{ tokenId: "_" }];
}
