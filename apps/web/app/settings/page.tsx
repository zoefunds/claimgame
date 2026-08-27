"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPatch } from "@/lib/api";
import { RequireWallet } from "@/components/RequireWallet";
import { useWallet } from "@/lib/wallet-context";

type Profile = { walletAddress: string; displayName: string | null; avatarUrl: string | null };

export default function SettingsPage() {
  return (
    <div className="p-container-padding md:p-8 max-w-2xl mx-auto w-full">
      <h1 className="font-headline-lg text-headline-lg text-on-surface mb-4">Settings</h1>
      <RequireWallet>
        <SettingsContent />
      </RequireWallet>
    </div>
  );
}

/**
 * Requires the backend session (see lib/wallet-context.tsx's auto sign-in
 * on connect) — `isAuthenticated` reflects whether that nonce-sign-verify
 * flow actually succeeded, since a wallet can be connected on-chain without
 * having signed the backend's message yet (rejected prompt, timing).
 */
function SettingsContent() {
  const { address, isAuthenticated, isAuthenticating, authError, signIn } = useWallet();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await apiGet<Profile>("/api/v1/me");
      setProfile(data);
      setDisplayName(data.displayName ?? "");
    } catch {
      // Not authenticated yet or request failed — handled by the
      // isAuthenticated banner below, nothing to show here.
    }
  }, []);

  useEffect(() => {
    if (isAuthenticated) load();
  }, [isAuthenticated, load]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const updated = await apiPatch<Profile>("/api/v1/me", { displayName });
      setProfile(updated);
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="font-code-sm text-code-sm text-primary">{address}</div>

      {!isAuthenticated && (
        <div className="border border-tertiary-container/30 bg-tertiary-container/10 rounded p-4 space-y-3">
          <p className="font-body-sm text-body-sm text-tertiary-container">
            Sign a message with your wallet to unlock profile settings — this only proves you own
            this address, it never triggers a transaction or costs gas.
          </p>
          {authError && <p className="font-code-sm text-code-sm text-error">{authError}</p>}
          <button
            onClick={signIn}
            disabled={isAuthenticating}
            className="bg-primary text-on-primary px-4 py-2 rounded font-data-label text-data-label uppercase tracking-widest hover:bg-primary-fixed-dim transition-colors disabled:opacity-60"
          >
            {isAuthenticating ? "Waiting for signature…" : "Sign In"}
          </button>
        </div>
      )}

      {isAuthenticated && (
        <form onSubmit={save} className="space-y-4">
          <label className="flex flex-col gap-1.5">
            <span className="font-data-label text-data-label text-on-surface-variant uppercase tracking-wider">
              Display Name
            </span>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={40}
              placeholder={profile ? "" : "Loading…"}
              className="bg-surface-container-lowest border border-outline-variant rounded px-3 py-2 text-on-surface focus:border-primary-container outline-none"
            />
          </label>

          {saveError && <p className="font-code-sm text-code-sm text-error">{saveError}</p>}
          {saved && <p className="font-code-sm text-code-sm text-primary">Saved.</p>}

          <button
            type="submit"
            disabled={saving}
            className="bg-primary text-on-primary px-4 py-2 rounded font-data-label text-data-label uppercase tracking-widest hover:bg-primary-fixed-dim transition-colors disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </form>
      )}
    </div>
  );
}
