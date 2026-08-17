"use client";

import { ArrowRight, ArrowRightLeft, FileType, Images, KeyRound, Link2, Lock, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { formatEther } from "viem";

import { useT, type MessageKey } from "@/i18n";
import { useTiers } from "@/lib/tiers";

import { Logo } from "./header";
import { Card, Spinner } from "./ui";

const FEATURES = [
  { key: "encryption", icon: Lock },
  { key: "ownership", icon: KeyRound },
  { key: "transfer", icon: ArrowRightLeft },
  { key: "sharing", icon: Link2 },
  { key: "previews", icon: Images },
  { key: "formats", icon: FileType },
] as const;

const STEPS = ["mint", "passphrase", "upload"] as const;

/** Decorative: three drives the way the app shows them. */
function DrivesPreview() {
  const drives = [
    { id: 1, gb: 4, used: 0.62 },
    { id: 2, gb: 2, used: 0.18 },
    { id: 3, gb: 1, used: 0.91 },
  ];
  return (
    <div className="grid gap-3">
      {drives.map((d) => (
        <Card key={d.id} className="flex items-center gap-4 p-4">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex justify-between text-sm">
              <span className="font-medium">Drive #{d.id}</span>
              <span className="text-muted">{d.gb} GB</span>
            </div>
            <div className="mt-2 h-1.5 rounded-full bg-bg-subtle">
              <div className="h-full rounded-full bg-accent" style={{ width: `${d.used * 100}%` }} />
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

function Tiers() {
  const t = useT();
  const { tiers, isLoading } = useTiers();
  if (isLoading) return <Spinner className="mx-auto" />;
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {tiers
        .filter((tier) => tier.active)
        .map((tier) => (
          <Card key={tier.id} className="p-6">
            <div className="text-3xl font-semibold tracking-tight">{t("drives.capacity", { gb: tier.capacityGb })}</div>
            <div className="mt-1 font-mono text-sm text-muted">{formatEther(tier.price)} ETH</div>
          </Card>
        ))}
    </div>
  );
}

export function Landing() {
  const t = useT();
  return (
    <div className="flex flex-1 flex-col">
      <header className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4">
        <Logo />
        <Link href="/drive" className="text-sm font-medium text-muted transition hover:text-fg">
          {t("nav.openApp")}
        </Link>
      </header>

      <main className="flex-1">
        <section className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-16 md:grid-cols-[1.2fr_1fr] md:py-24">
          <div>
            <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-xs text-muted">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
              {t("landing.eyebrow")}
            </p>
            <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">{t("landing.title")}</h1>
            <p className="mt-5 max-w-xl text-lg text-pretty text-muted">{t("landing.subtitle")}</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href="/drive"
                className="inline-flex h-11 items-center gap-2 rounded-lg bg-accent px-5 text-sm font-medium text-accent-fg transition hover:opacity-90"
              >
                {t("landing.ctaPrimary")}
                <ArrowRight className="h-4 w-4" />
              </Link>
              <a
                href="#how"
                className="inline-flex h-11 items-center rounded-lg border border-border px-5 text-sm font-medium transition hover:bg-bg-subtle"
              >
                {t("landing.ctaSecondary")}
              </a>
            </div>
            <p className="mt-6 text-xs text-muted">{t("landing.testnet")}</p>
          </div>
          <DrivesPreview />
        </section>

        <section className="border-t border-border bg-bg-subtle">
          <div className="mx-auto max-w-6xl px-4 py-20">
            <h2 className="text-2xl font-semibold tracking-tight">{t("landing.featuresTitle")}</h2>
            <div className="mt-10 grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map(({ key, icon: Icon }) => (
                <div key={key}>
                  <Icon className="h-5 w-5 text-accent" />
                  <h3 className="mt-3 font-medium">{t(`landing.features.${key}.title` as MessageKey)}</h3>
                  <p className="mt-1 text-sm text-muted">{t(`landing.features.${key}.text` as MessageKey)}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="how" className="mx-auto max-w-6xl scroll-mt-8 px-4 py-20">
          <h2 className="text-2xl font-semibold tracking-tight">{t("landing.stepsTitle")}</h2>
          <ol className="mt-10 grid gap-6 sm:grid-cols-3">
            {STEPS.map((key, i) => (
              <li key={key} className="border-l-2 border-border pl-4">
                <span className="font-mono text-sm text-muted">0{i + 1}</span>
                <h3 className="mt-1 font-medium">{t(`landing.steps.${key}.title` as MessageKey)}</h3>
                <p className="mt-1 text-sm text-muted">{t(`landing.steps.${key}.text` as MessageKey)}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="border-t border-border">
          <div className="mx-auto max-w-6xl px-4 py-20">
            <h2 className="text-2xl font-semibold tracking-tight">{t("landing.tiersTitle")}</h2>
            <p className="mt-2 text-sm text-muted">{t("landing.tiersText")}</p>
            <div className="mt-8">
              <Tiers />
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto max-w-6xl px-4 py-6 text-xs text-muted">{t("landing.footer")}</div>
      </footer>
    </div>
  );
}
