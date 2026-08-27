"use client";

import { createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { getAccount } from "@wagmi/core";
import { wagmiConfig } from "./wagmi-config";
import { getContractConfig } from "./env";

export class NoWalletError extends Error {
  constructor() {
    super("No wallet connected. Use the Connect Wallet button first.");
    this.name = "NoWalletError";
  }
}

/**
 * Pulls the EIP-1193 provider off whichever connector wagmi/Reown AppKit
 * currently has active — this works uniformly whether the user connected
 * an injected browser wallet (MetaMask, Rainbow extension) or a mobile
 * wallet over WalletConnect (no `window.ethereum` involved at all in that
 * case), which is exactly the case the previous window.ethereum-only
 * implementation couldn't handle.
 *
 * Typed loosely (`unknown` for the provider) on purpose: genlayer-js@1.1.8
 * doesn't export its internal `EthereumProvider` type for us to import and
 * match structurally, and wagmi connectors return their provider as a
 * library-specific type — both sides just need "an EIP-1193-shaped object
 * with `.request()`", which every wallet provider satisfies at runtime.
 */
async function getActiveEip1193Provider(): Promise<{ provider: unknown; address: `0x${string}` }> {
  const account = getAccount(wagmiConfig);
  if (!account.isConnected || !account.address || !account.connector) {
    throw new NoWalletError();
  }
  const provider = await account.connector.getProvider();
  return { provider, address: account.address };
}

/** Builds a genlayer-js client bound to the connected wallet's account and
 * its actual EIP-1193 provider, so every write is signed by the user,
 * never by the backend. Throws NoWalletError if nothing is connected —
 * call sites should have already gated on `useWallet().address` via
 * <RequireWallet>, so this is a defensive backstop, not the primary check. */
export async function getWalletClient(expectedAddress: `0x${string}`) {
  const { provider, address } = await getActiveEip1193Provider();
  if (address.toLowerCase() !== expectedAddress.toLowerCase()) {
    throw new Error("Connected wallet changed — reconnect and try again.");
  }
  return createClient({
    chain: studionet,
    account: expectedAddress,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    provider: provider as any,
  });
}

/** Read-only client — no account/signing required, safe to use before a
 * wallet is connected (Hunt Board, claim detail, leaderboard, etc). */
export function getReadClient() {
  getContractConfig(); // throws early with a clear message if misconfigured
  return createClient({ chain: studionet });
}
