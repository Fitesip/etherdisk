"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";

import { I18nProvider } from "@/i18n";
import { SessionProvider } from "@/lib/session";
import { UnlockedProvider } from "@/lib/unlocked";
import { wagmiConfig } from "@/lib/wagmi";

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { staleTime: 10_000, retry: 1, refetchOnWindowFocus: false } } }),
  );
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <SessionProvider>
            <UnlockedProvider>{children}</UnlockedProvider>
          </SessionProvider>
        </I18nProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
