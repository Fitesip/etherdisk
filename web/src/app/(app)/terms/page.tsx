import type { Metadata } from "next";

import { LegalPage } from "@/components/legal";
import terms from "@/legal/terms.md";

export const metadata: Metadata = { title: "Terms of Service · Etherdisk" };

export default function TermsPage() {
  return <LegalPage source={terms} />;
}
