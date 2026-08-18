"use client";

import { Check, X } from "lucide-react";

import { useT } from "@/i18n";
import { MIN_PASSPHRASE_LENGTH } from "@/lib/config";
import { PASSPHRASE_RULES } from "@/lib/passphrase";

import { cn } from "./ui";

/** Live checklist of the passphrase requirements. */
export function PassphraseRules({ value }: { value: string }) {
  const t = useT();
  return (
    <div className="text-xs" aria-live="polite">
      <p className="text-muted">{t("vault.rulesTitle")}</p>
      <ul className="mt-1 grid gap-0.5 sm:grid-cols-2">
        {PASSPHRASE_RULES.map((r) => {
          const ok = r.ok(value);
          const Icon = ok ? Check : X;
          return (
            <li key={r.key} className={cn("flex items-center gap-1.5", ok ? "text-success" : "text-muted")}>
              <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>
                {t(r.key, { n: MIN_PASSPHRASE_LENGTH })}
                <span className="sr-only">{ok ? " ✓" : ""}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
