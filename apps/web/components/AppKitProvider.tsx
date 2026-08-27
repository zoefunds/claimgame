"use client";

import { useState } from "react";
import { createAppKit } from "@reown/appkit/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { wagmiAdapter, networks, REOWN_PROJECT_ID } from "@/lib/wagmi-config";

const metadata = {
  name: "CLAIMGAME",
  description: "Put money behind your interpretation of a protocol.",
  url: "https://claim-game.vercel.app",
  icons: ["https://claim-game.vercel.app/favicon.svg"],
};

// createAppKit registers the <appkit-button>/<appkit-modal> web components
// and must run once at module scope (per Reown's documented setup) — not
// inside the component body, or it re-registers on every render.
createAppKit({
  adapters: [wagmiAdapter],
  projectId: REOWN_PROJECT_ID,
  networks: [networks[0], ...networks.slice(1)],
  metadata,
  features: { analytics: false },
});

/**
 * Wraps the app with wagmi + Reown AppKit so `connect()` opens a real
 * multi-wallet modal (injected browser wallets, WalletConnect QR for
 * mobile wallets, etc.) instead of only working when a browser extension
 * happens to be installed — that gap is what made "connect wallet" flaky
 * before this.
 */
export function AppKitProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={wagmiAdapter.wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
