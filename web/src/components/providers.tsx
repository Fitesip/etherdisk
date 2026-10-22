"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Suspense, useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";

import { I18nProvider } from "@/i18n";
import { SessionProvider } from "@/lib/session";
import { UnlockedProvider } from "@/lib/unlocked";
import { wagmiConfig } from "@/lib/wagmi";

import { SharedFiles } from "./shared-files";
import { ToastProvider } from "./toast";

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { staleTime: 10_000, retry: 1, refetchOnWindowFocus: false } } }),
  );
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <SessionProvider>
            <UnlockedProvider>
              <ToastProvider>
                {children}
                {/* Reads the route: outside of it, prerendering a dynamic page would bail out. */}
                <Suspense fallback={null}>
                  <SharedFiles />
                </Suspense>
              </ToastProvider>
            </UnlockedProvider>
          </SessionProvider>
        </I18nProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
