"use client";

import Link from "next/link";
import { useWallet } from "@/lib/wallet-context";

function truncate(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function MobileHeader() {
  const { address, isConnecting, connect } = useWallet();

  return (
    <header className="fixed top-0 w-full z-50 flex justify-between items-center px-container-padding h-16 bg-surface/95 backdrop-blur-sm border-b border-outline-variant md:hidden">
      <Link href="/" className="font-headline-md text-headline-md text-primary">
        CLAIMGAME
      </Link>
      <button
        onClick={address ? undefined : connect}
        disabled={isConnecting}
        className="font-data-label text-data-label bg-surface-container-high text-primary px-3 py-1.5 rounded border border-outline-variant disabled:opacity-60"
      >
        {address ? truncate(address) : isConnecting ? "Connecting…" : "Connect Wallet"}
      </button>
    </header>
  );
}
