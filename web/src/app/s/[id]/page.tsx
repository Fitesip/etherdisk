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
