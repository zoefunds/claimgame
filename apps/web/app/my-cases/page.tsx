"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiGet } from "@/lib/api";
import type { BackendClaim, Claim } from "@/lib/types";
import { mapBackendClaim } from "@/lib/types";
import { RequireWallet } from "@/components/RequireWallet";
import { useWallet } from "@/lib/wallet-context";
import { DifficultyBadge, GenAmount } from "@/components/Badges";
import { usePolling } from "@/lib/use-polling";

const POLL_INTERVAL_MS = 10_000;

/**
 * Reads from the backend's Postgres cache (`GET /api/v1/claims?creator=` /
 * `?challenger=`), not directly from GenLayer — see app/claims/page.tsx's
 * module docstring for why: N browser tabs polling GenLayer's shared
 * StudioNet RPC directly risks its rate limit, while polling our own
 * Fly-hosted API doesn't touch GenLayer at all. The indexer keeps this
 * cache within ~5s of the contract.
 */
export default function MyCasesPage() {
  return (
    <div className="p-container-padding md:p-8 max-w-7xl mx-auto w-full space-y-6">
      <div>
        <h1 className="font-headline-lg text-headline-lg text-on-surface mb-1">My Cases</h1>
        <p className="font-body-sm text-body-sm text-on-surface-variant">
          Claims and challenges tied to your connected wallet.
        </p>
      </div>
      <RequireWallet>
        <MyCasesList />
      </RequireWallet>
    </div>
  );
}

function MyCasesList() {
  const { address } = useWallet();
  const [claimed, setClaimed] = useState<Claim[] | null>(null);
  const [challenged, setChallenged] = useState<Claim[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!address) return;
    try {
      const [claimedRows, challengedRows] = await Promise.all([
        apiGet<BackendClaim[]>(`/api/v1/claims?creator=${address}&limit=50`),
        apiGet<BackendClaim[]>(`/api/v1/claims?challenger=${address}&limit=50`),
      ]);
      setClaimed(claimedRows.map(mapBackendClaim));
      setChallenged(challengedRows.map(mapBackendClaim));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load your cases");
    }
  }, [address]);

  useEffect(() => {
    load();
  }, [load]);

  usePolling(load, POLL_INTERVAL_MS);

  if (error) {
    return <div className="border border-error/30 bg-error/10 text-error p-4 rounded font-code-sm text-code-sm">{error}</div>;
  }

  if (!claimed || !challenged) {
    return <div className="animate-pulse text-on-surface-variant font-body-sm text-body-sm">Loading your cases…</div>;
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
      <CaseList title="Claims You Created" items={claimed} emptyLabel="You haven't created a claim yet." />
      <CaseList title="Claims You Challenged" items={challenged} emptyLabel="You haven't challenged a claim yet." />
    </div>
  );
}

function CaseList({ title, items, emptyLabel }: { title: string; items: Claim[]; emptyLabel: string }) {
  return (
    <section className="space-y-3">
      <h3 className="font-data-label text-data-label text-outline uppercase tracking-widest">
        {title} ({items.length})
      </h3>
      {items.length === 0 && <p className="text-on-surface-variant font-body-sm text-body-sm">{emptyLabel}</p>}
      <div className="space-y-2">
        {items.map((claim) => (
          <Link
            key={claim.id}
            href={`/claims/${claim.id}`}
            className="flex items-center justify-between p-3 bg-surface border border-outline-variant rounded hover:border-primary/50 transition-colors"
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-code-sm text-code-sm text-on-surface-variant shrink-0">#{claim.id}</span>
              <span className="font-body-sm text-body-sm text-on-surface truncate">{claim.subject}</span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <DifficultyBadge difficulty={claim.difficulty} />
              <GenAmount baseUnits={claim.claim_bond_deposited} />
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
