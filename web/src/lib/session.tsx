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

const storageKey = (a: Address) => `nftvault.session.${a.toLowerCase()}`;

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
  signOut: () => void;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const { address } = useConnection();
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
    try {
      const { nonce } = await api.nonce();
      const message = createSiweMessage({
        domain: window.location.host,
        address,
        statement: "Sign in to NFT Vault",
        uri: window.location.origin,
        version: "1",
        chainId: CHAIN.id,
        nonce,
      });
      const signature = await signMessage.mutateAsync({ message });
      const s = await api.verify(message, signature);
      writeStored(storageKey(address), JSON.stringify({ token: s.token, expiresAt: s.expires_at } satisfies Stored));
    } finally {
      setSigningIn(false);
    }
  }, [address, signMessage]);

  const value = useMemo(
    () => ({ address, token, signIn, signingIn, signOut }),
    [address, token, signIn, signingIn, signOut],
  );
  return <SessionContext value={value}>{children}</SessionContext>;
}

export function useSession(): Session {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession outside SessionProvider");
  return ctx;
}
