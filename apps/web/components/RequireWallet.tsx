"use client";

import { useWallet } from "@/lib/wallet-context";

/** Gates children behind an actually-connected wallet, reading from the
 * same WalletProvider context every other wallet-aware component uses —
 * this is what was missing on My Cases / Profile / the claim-detail action
 * panel / create-claim: they either showed static placeholder text or
 * silently re-triggered their own connect flow instead of reacting to the
 * address already sitting in context. */
export function RequireWallet({ children }: { children: React.ReactNode }) {
  const { address, isConnecting, error, connect } = useWallet();

  if (address) return <>{children}</>;

  return (
    <div className="border border-outline-variant rounded p-8 text-center space-y-3 bg-surface-container-low">
      <p className="font-body-md text-body-md text-on-surface-variant">
        Connect your wallet to continue.
      </p>
      <button
        onClick={connect}
        disabled={isConnecting}
        className="inline-block px-6 py-2 bg-primary text-on-primary font-data-label text-data-label uppercase tracking-widest rounded hover:bg-primary-fixed-dim transition-colors disabled:opacity-60"
      >
        {isConnecting ? "Connecting…" : "Connect Wallet"}
      </button>
      {error && <p className="font-code-sm text-code-sm text-error">{error}</p>}
    </div>
  );
}
