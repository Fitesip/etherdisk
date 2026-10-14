"use client";

// Backend session obtained with Sign-In with Ethereum. One token per wallet address,
// kept in localStorage so a reload does not ask for another signature.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Address } from "viem";
import { createSiweMessage } from "viem/siwe";
import { useConnection, useSignMessage } from "wagmi";

import { api, UNAUTHORIZED_EVENT } from "./api";
import { readStored, useStored, writeStored } from "./storage";
import { CHAIN } from "./wagmi";

interface Stored {
  token: string;
  expiresAt: number;
}

const storageKey = (a: Address) => `etherdisk.session.${a.toLowerCase()}`;

function parse(raw: string | null): string | null {
  try {
    const s = JSON.parse(raw ?? "null") as Stored | null;
    if (s && s.expiresAt * 1000 > Date.now()) return s.token;
  } catch {}
  return null;
}

interface Session {
  address: Address | undefined;
  /** Backend bearer token for `address`, or null if not signed in. */
  token: string | null;
  signIn: () => Promise<void>;
  signingIn: boolean;
  /** Why the last sign-in failed ("rejected": the wallet declined), or null. */
  signInError: "rejected" | string | null;
  /** Signing goes through WalletConnect: the request waits in the wallet app. */
  viaWalletConnect: boolean;
  signOut: () => void;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const { address, connector } = useConnection();
  const viaWalletConnect = connector?.type === "walletConnect";
  const [signInError, setSignInError] = useState<string | null>(null);
  const signMessage = useSignMessage();
  const raw = useStored(address ? storageKey(address) : null);
  const token = useMemo(() => parse(raw), [raw]);
  const [signingIn, setSigningIn] = useState(false);

  const signOut = useCallback(() => {
    if (!address) return;
    const t = parse(readStored(storageKey(address)));
    writeStored(storageKey(address), null);
    if (t) api.logout(t).catch(() => {});
  }, [address]);

  useEffect(() => {
    const onUnauthorized = () => {
      if (address) writeStored(storageKey(address), null);
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [address]);

  const signIn = useCallback(async () => {
    if (!address) return;
    setSigningIn(true);
    setSignInError(null);
    try {
      const { nonce } = await api.nonce();
      const message = createSiweMessage({
        domain: window.location.host,
        address,
        statement: "Sign in to Etherdisk",
        uri: window.location.origin,
        version: "1",
        chainId: CHAIN.id,
        nonce,
      });
      const signing = signMessage.mutateAsync({ message });
      // WalletConnect only relays the request: on a phone, bring the wallet app up for it.
      if (viaWalletConnect && connector) void openWalletApp(connector);
      const signature = await signing;
      const s = await api.verify(message, signature);
      writeStored(storageKey(address), JSON.stringify({ token: s.token, expiresAt: s.expires_at } satisfies Stored));
    } catch (e) {
      setSignInError(isRejection(e) ? "rejected" : e instanceof Error ? e.message.split("\n")[0] : String(e));
      throw e;
    } finally {
      setSigningIn(false);
    }
  }, [address, signMessage, viaWalletConnect, connector]);

  const value = useMemo(
    () => ({ address, token, signIn, signingIn, signInError, viaWalletConnect, signOut }),
    [address, token, signIn, signingIn, signInError, viaWalletConnect, signOut],
  );
  return <SessionContext value={value}>{children}</SessionContext>;
}

/** The wallet declined (EIP-1193 code 4001, or viem's UserRejectedRequestError). */
function isRejection(e: unknown): boolean {
  for (let err = e as { code?: number; name?: string; cause?: unknown } | undefined; err; err = err.cause as typeof err) {
    if (err.code === 4001 || err.name === "UserRejectedRequestError") return true;
  }
  return false;
}

/**
 * On a phone, opens the wallet app a WalletConnect session belongs to (its deep link from
 * the session's metadata), so a pending request shows up there. Does nothing on desktop:
 * the request reaches the phone that scanned the QR code by itself.
 */
async function openWalletApp(connector: { getProvider: () => Promise<unknown> }) {
  if (!matchMedia("(pointer: coarse)").matches) return;
  try {
    const provider = (await connector.getProvider()) as {
      session?: { peer?: { metadata?: { redirect?: { native?: string; universal?: string } } } };
    };
    const redirect = provider.session?.peer?.metadata?.redirect;
    const link = redirect?.native || redirect?.universal;
    if (link) window.location.href = link;
  } catch {
    // No deep link: the user opens the wallet app themselves (the hint says so).
  }
}

export function useSession(): Session {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession outside SessionProvider");
  return ctx;
}
