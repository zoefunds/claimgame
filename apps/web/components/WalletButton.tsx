"use client";

import { useWallet } from "@/lib/wallet-context";

function truncate(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function WalletButton() {
  const { address, isConnecting, error, connect, disconnect } = useWallet();

  if (address) {
    return (
      <button
        onClick={disconnect}
        title="Click to disconnect"
        className="w-full bg-surface p-3 rounded border border-outline-variant text-left hover:border-primary/50 transition-colors"
      >
        <div className="font-data-label text-data-label text-on-surface-variant">WALLET</div>
        <div className="font-code-sm text-code-sm text-primary">{truncate(address)}</div>
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        onClick={connect}
        disabled={isConnecting}
        className="w-full bg-surface p-3 rounded border border-outline-variant text-left hover:border-primary/50 transition-colors disabled:opacity-60"
      >
        <div className="font-data-label text-data-label text-on-surface-variant">GEN BALANCE</div>
        <div className="font-code-sm text-code-sm text-primary">
          {isConnecting ? "Connecting…" : "Connect Wallet"}
        </div>
      </button>
      {error && <p className="font-body-sm text-body-sm text-error px-1">{error}</p>}
    </div>
  );
}
