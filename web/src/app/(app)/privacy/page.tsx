import type { Metadata } from "next";

import { LegalPage } from "@/components/legal";
import privacy from "@/legal/privacy.md";

export const metadata: Metadata = { title: "Privacy Policy · Etherdisk" };

export default function PrivacyPage() {
  return <LegalPage source={privacy} />;
}
