import { Suspense } from "react";

import { SharedView } from "@/components/shared-view";
import { Spinner } from "@/components/ui";

export default function SharePage() {
  return (
    <Suspense fallback={<Spinner className="mx-auto mt-24" />}>
      <SharedView />
    </Suspense>
  );
}

// The static export (the desktop app) has one page, for `_`, served for every id (lib/route-param.ts).
export function generateStaticParams() {
  return [{ id: "_" }];
}
