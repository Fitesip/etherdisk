import { Suspense } from "react";

import { DriveView } from "@/components/drive/drive-view";
import { Spinner } from "@/components/ui";

export default function DriveSettingsPage() {
  return (
    <Suspense fallback={<Spinner className="mx-auto mt-24" />}>
      <DriveView tab="settings" />
    </Suspense>
  );
}
