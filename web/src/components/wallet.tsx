"use client";

import { ChevronDown, LogOut, Wallet } from "lucide-react";
import { useState } from "react";
import { useConnect, useConnection, useConnectors, useDisconnect, type Connector } from "wagmi";

import { useT } from "@/i18n";
import { WC_PROJECT_ID } from "@/lib/config";
import { shortAddress } from "@/lib/format";
import { useHydrated } from "@/lib/hydrated";
import { useSession } from "@/lib/session";

import { Button, Dialog, Notice } from "./ui";

/** EIP-6963 wallets first; the generic "Injected" only when nothing announced itself. */
function useWalletList(): readonly Connector[] {
  const connectors = useConnectors();
  const announced = connectors.filter((c) => c.type === "injected" && c.id !== "injected");
  return connectors.filter((c) => c.id !== "injected" || announced.length === 0);
}

export function ConnectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const connect = useConnect();
  const wallets = useWalletList();
  const hasInjected = wallets.some((c) => c.type === "injected");

  const pick = (connector: Connector) => {
    // Close first: the modal <dialog> sits in the top layer and would cover
    // WalletConnect's own QR modal.
    onClose();
    connect.mutate({ connector });
  };

  return (
    <Dialog open={open} onClose={onClose} title={t("wallet.chooseWallet")}>
      <div className="flex flex-col gap-2">
        {wallets.map((c) => (
          <button
            key={c.uid}
            type="button"
            onClick={() => pick(c)}
            className="flex h-12 items-center gap-3 rounded-lg border border-border px-3 text-left text-sm font-medium transition hover:bg-bg-subtle"
          >
            {c.icon ? (
              // eslint-disable-next-line @next/next/no-img-element -- data: URIs from wallets
              <img src={c.icon} alt="" className="h-6 w-6 rounded" />
            ) : (
              <Wallet className="h-5 w-5 text-muted" />
            )}
            {c.id === "injected" ? t("wallet.browserWallet") : c.name}
          </button>
        ))}
        {!hasInjected && (
          <Notice>
            {t("wallet.noWallets")}{" "}
            <a className="text-accent underline" href="https://metamask.io/download" target="_blank" rel="noreferrer">
              {t("wallet.installMetaMask")}
            </a>
          </Notice>
        )}
        {!WC_PROJECT_ID && <p className="text-xs text-muted">{t("wallet.walletConnectDisabled")}</p>}
      </div>
    </Dialog>
  );
}

export function ConnectButton({ className }: { className?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { status } = useConnection();
  const hydrated = useHydrated();
  return (
    <>
      <Button variant="primary" className={className} loading={hydrated && (status === "connecting" || status === "reconnecting")} onClick={() => setOpen(true)}>
        <Wallet className="h-4 w-4" />
        {t("wallet.connect")}
      </Button>
      <ConnectDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/** Header control: connect, or the connected address with a disconnect menu. */
export function WalletButton() {
  const t = useT();
  const { address, isConnected } = useConnection();
  const disconnect = useDisconnect();
  const { signOut } = useSession();

  const hydrated = useHydrated();

  if (!hydrated || !isConnected || !address) return <ConnectButton />;
  return (
    <details className="group relative">
      <summary className="flex h-9 cursor-pointer list-none items-center gap-2 rounded-lg border border-border px-3 font-mono text-sm whitespace-nowrap hover:bg-bg-subtle">
        <span className="h-2 w-2 rounded-full bg-success" />
        {shortAddress(address)}
        <ChevronDown className="h-4 w-4 text-muted transition group-open:rotate-180" />
      </summary>
      <div className="absolute right-0 z-20 mt-1 w-48 origin-top-right animate-pop-in rounded-lg border border-border bg-card p-1 shadow-lg">
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-bg-subtle"
          onClick={() => {
            signOut();
            disconnect.mutate();
          }}
        >
          <LogOut className="h-4 w-4" />
          {t("wallet.disconnect")}
        </button>
      </div>
    </details>
  );
}
