"use client";

import { HardDrive, Lightbulb, Settings } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense } from "react";

import { useT } from "@/i18n";

import { cn } from "./ui";
import { WalletButton } from "./wallet";

export function Logo() {
  const t = useT();
  return (
    <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
      <span className="grid h-7 w-7 place-items-center rounded-lg bg-fg text-bg">
        <HardDrive className="h-4 w-4" />
      </span>
      <span className="hidden whitespace-nowrap sm:inline">{t("common.appName")}</span>
    </Link>
  );
}

function NavLinks({ active }: { active?: string }) {
  const t = useT();
  const nav = [
    { href: "/drive", label: t("nav.drives"), icon: HardDrive },
    { href: "/ideas", label: t("nav.ideas"), icon: Lightbulb },
    { href: "/settings", label: t("nav.settings"), icon: Settings },
  ];
  return (
    <nav className="flex items-center gap-1">
      {nav.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          className={cn(
            "flex h-8 items-center gap-2 rounded-md px-3 text-sm transition",
            active?.startsWith(href) ? "bg-bg-subtle font-medium" : "text-muted hover:text-fg",
          )}
        >
          <Icon className="h-4 w-4" />
          <span className="hidden sm:inline">{label}</span>
        </Link>
      ))}
    </nav>
  );
}

// The pathname is request-time data on dynamic routes, so it streams in under Suspense.
function ActiveNav() {
  return <NavLinks active={usePathname()} />;
}

export function AppHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-bg/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 sm:gap-6">
        <Logo />
        <Suspense fallback={<NavLinks />}>
          <ActiveNav />
        </Suspense>
        <div className="ml-auto">
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
