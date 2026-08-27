"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useDisconnect, useSignMessage } from "wagmi";
import { useAppKit } from "@reown/appkit/react";
import { signInWithWallet, signOut } from "./auth";

type WalletState = {
  address: `0x${string}` | null;
  isConnecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  /** Whether the backend session (sign-in-with-wallet) is established —
   * separate from on-chain connection: a wallet can be connected (able to
   * sign contract writes) without yet having signed the backend's nonce
   * message. Only NATIVE-data features (profile, notifications) need this. */
  isAuthenticated: boolean;
  isAuthenticating: boolean;
  authError: string | null;
  signIn: () => Promise<void>;
};

const WalletContext = createContext<WalletState | null>(null);

/**
 * The one place wallet connection state lives — wagmi + Reown AppKit for
 * the on-chain connection, plus the backend's sign-in-with-wallet session
 * layered on top. `connect()` opens AppKit's modal; once an address is
 * available, this automatically attempts the nonce-sign-verify flow once
 * per connection so "connected" also means "authenticated" without an
 * extra button most of the time — a rejected/failed signature just leaves
 * `isAuthenticated` false with `authError` set, `signIn()` is there for a
 * manual retry (see Settings page).
 */
export function WalletProvider({ children }: { children: React.ReactNode }) {
  const { address, isConnected } = useAccount();
  const { disconnectAsync } = useDisconnect();
  const { signMessageAsync } = useSignMessage();
  const { open } = useAppKit();
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const attemptedForAddress = useRef<string | null>(null);

  const connect = useCallback(async () => {
    setError(null);
    setIsConnecting(true);
    try {
      await open({ view: "Connect" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open wallet connect modal");
    } finally {
      setIsConnecting(false);
    }
  }, [open]);

  const signIn = useCallback(async () => {
    if (!address) return;
    setAuthError(null);
    setIsAuthenticating(true);
    try {
      await signInWithWallet(address, signMessageAsync);
      setIsAuthenticated(true);
    } catch (err) {
      setIsAuthenticated(false);
      setAuthError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setIsAuthenticating(false);
    }
  }, [address, signMessageAsync]);

  // Auto-attempt sign-in once per newly connected address. Guarded by a
  // ref (not state) so a failed/rejected attempt doesn't retry on every
  // render — the user can still retry manually via signIn().
  useEffect(() => {
    if (isConnected && address && attemptedForAddress.current !== address) {
      attemptedForAddress.current = address;
      signIn();
    }
    if (!isConnected) {
      attemptedForAddress.current = null;
      setIsAuthenticated(false);
    }
  }, [isConnected, address, signIn]);

  const disconnect = useCallback(() => {
    setIsAuthenticated(false);
    signOut();
    disconnectAsync().catch(() => {
      /* no-op: session may already be gone */
    });
  }, [disconnectAsync]);

  const value = useMemo(
    () => ({
      address: isConnected ? (address ?? null) : null,
      isConnecting,
      error,
      connect,
      disconnect,
      isAuthenticated,
      isAuthenticating,
      authError,
      signIn,
    }),
    [address, isConnected, isConnecting, error, connect, disconnect, isAuthenticated, isAuthenticating, authError, signIn],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within a WalletProvider");
  return ctx;
}
