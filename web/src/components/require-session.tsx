"use client";

import { PenLine, Wallet } from "lucide-react";
import type { ReactNode } from "react";
import { useConnection, useSwitchChain } from "wagmi";

import { useT } from "@/i18n";
import { useHydrated } from "@/lib/hydrated";
import { useSession } from "@/lib/session";
import { CHAIN } from "@/lib/wagmi";

import { Button, Card, Spinner } from "./ui";
import { ConnectButton } from "./wallet";

function Panel({ icon, title, text, children }: { icon: ReactNode; title: string; text: string; children: ReactNode }) {
  return (
    <Card className="mx-auto mt-16 flex max-w-md flex-col items-center gap-4 p-8 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-full bg-accent-soft text-accent">{icon}</div>
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="text-sm text-muted">{text}</p>
      {children}
    </Card>
  );
}

/** Renders children only for a connected wallet on Sepolia with a backend session. */
export function RequireSession({ children }: { children: (token: string) => ReactNode }) {
  const t = useT();
  const hydrated = useHydrated();
  const { status, chainId } = useConnection();
  const switchChain = useSwitchChain();
  const { token, signIn, signingIn } = useSession();

  if (!hydrated || status === "connecting" || status === "reconnecting") return <Spinner className="mx-auto mt-24" />;
  if (status !== "connected") {
    return (
      <Panel icon={<Wallet className="h-6 w-6" />} title={t("wallet.connectTitle")} text={t("wallet.connectText")}>
        <ConnectButton />
      </Panel>
    );
  }
  if (chainId !== CHAIN.id) {
    return (
      <Panel icon={<Wallet className="h-6 w-6" />} title={t("wallet.wrongNetwork")} text="">
        <Button variant="primary" loading={switchChain.isPending} onClick={() => switchChain.mutate({ chainId: CHAIN.id })}>
          {t("wallet.switchTo", { chain: CHAIN.name })}
        </Button>
      </Panel>
    );
  }
  if (!token) {
    return (
      <Panel icon={<PenLine className="h-6 w-6" />} title={t("wallet.signInTitle")} text={t("wallet.signInText")}>
        <Button variant="primary" loading={signingIn} onClick={() => signIn().catch(() => {})}>
          {signingIn ? t("wallet.signingIn") : t("wallet.signIn")}
        </Button>
      </Panel>
    );
  }
  return <>{children(token)}</>;
}
