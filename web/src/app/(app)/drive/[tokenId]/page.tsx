import { Suspense } from "react";

import { DriveView } from "@/components/drive/drive-view";
import { Spinner } from "@/components/ui";

// The token id is only known at request time, so the view (useParams) renders inside Suspense.
export default function DrivePage() {
  return (
    <Suspense fallback={<Spinner className="mx-auto mt-24" />}>
      <DriveView />
    </Suspense>
  );
}

// The static export (the desktop app) has one page, for `_`, served for every id (lib/route-param.ts).
export function generateStaticParams() {
  return [{ tokenId: "_" }];
}
