"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { apiGet } from "@/lib/api";
import { contractReads } from "@/lib/contract";
import type { BackendClaim, Claim } from "@/lib/types";
import { mapBackendClaim } from "@/lib/types";
import { DifficultyBadge, StatusBadge, GenAmount } from "@/components/Badges";
import { usePolling } from "@/lib/use-polling";

const POLL_INTERVAL_MS = 8_000;

/**
 * Hunt Board reads from the backend's Postgres cache
 * (`GET /api/v1/claims`), NOT directly from GenLayer. The cache is kept
 * fresh by one centralized indexer process polling the contract every 5
 * minutes (apps/api/src/indexer) — every open browser tab polling GenLayer's
 * StudioNet RPC directly every 8s would multiply with concurrent users and
 * risk the shared RPC's rate limit; polling our own Fly-hosted API instead
 * doesn't touch GenLayer at all per page view. Contract reads/writes still
 * happen directly from the browser for anything that needs to be
 * authoritative (claim detail's action panel, create-claim).
 *
 * A claim created moments ago can be missing from that cache for up to one
 * indexer cycle. Mirrors claims/[id]/page.tsx's `reloadFromChain` fallback:
 * once per mount (never on every poll — that would recreate the exact
 * rate-limit risk the cache exists to avoid), compare the cache against
 * on-chain `get_claim_count`; any higher id the cache doesn't have yet is
 * fetched directly and merged in, so a just-created claim shows up on the
 * Hunt Board immediately instead of waiting out the indexer's cycle. The
 * next successful cache poll naturally supersedes these entries once the
 * indexer catches up (same id, cache copy wins — see the merge in `load`).
 */
export default function HuntBoardPage() {
  const [claims, setClaims] = useState<Claim[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const chainReconciled = useRef(false);

  const load = useCallback(async () => {
    try {
      const rows = await apiGet<BackendClaim[]>("/api/v1/claims?limit=50");
      const cached = rows.map(mapBackendClaim);
      setClaims((prev) => mergeClaims(cached, prev));
      setError(null);

      if (!chainReconciled.current) {
        chainReconciled.current = true;
        reconcileWithChain(cached).catch(() => {
          // Best-effort only — if this fails, the claim still appears once
          // the indexer's next cycle runs. Never surface this as a page error.
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load claims");
    }
  }, []);

  const reconcileWithChain = useCallback(async (cached: Claim[]) => {
    const totalCount = await contractReads.getClaimCount();
    const cachedIds = new Set(cached.map((c) => c.id));
    const missingIds: string[] = [];
    for (let id = totalCount; id >= 1; id--) {
      const idStr = String(id);
      if (!cachedIds.has(idStr)) missingIds.push(idStr);
    }
    if (missingIds.length === 0) return;

    const fetched = await Promise.all(
      missingIds.map((id) => contractReads.getClaim(id) as Promise<Claim>),
    );
    setClaims((prev) => mergeClaims(fetched, prev));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  usePolling(load, POLL_INTERVAL_MS);

  return (
    <div className="p-container-padding md:p-8 max-w-7xl mx-auto w-full flex flex-col gap-6">
      <div>
        <h1 className="font-headline-lg text-headline-lg text-on-surface mb-1">Hunt Board</h1>
        <p className="font-body-sm text-body-sm text-on-surface-variant">
          Active investigations, refreshed from the contract every few seconds.
        </p>
      </div>

      {error && (
        <div className="border border-error/30 bg-error/10 text-error p-4 rounded font-code-sm text-code-sm">
          {error}
        </div>
      )}

      {!claims && !error && (
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-56 bg-surface-container-lowest border border-outline-variant rounded animate-pulse" />
          ))}
        </div>
      )}

      {claims && claims.length === 0 && (
        <div className="border border-outline-variant rounded p-12 text-center text-on-surface-variant font-body-md">
          No active investigations yet.{" "}
          <Link href="/claims/new" className="text-primary underline">
            Create the first claim
          </Link>
          .
        </div>
      )}

      {claims && claims.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
          {claims.map((claim) => (
            <Link
              key={claim.id}
              href={`/claims/${claim.id}`}
              className="bg-surface border border-outline-variant rounded flex flex-col hover:border-primary/50 transition-colors p-4 gap-4"
            >
              <div className="flex justify-between items-start">
                <div className="flex items-center gap-2">
                  <span className="font-code-sm text-code-sm text-on-surface-variant bg-surface-container px-1.5 py-0.5 rounded border border-outline-variant">
                    #{claim.id}
                  </span>
                  <span className="font-data-label text-data-label text-primary uppercase tracking-wider">
                    {claim.protocol}
                  </span>
                </div>
                <DifficultyBadge difficulty={claim.difficulty} />
              </div>
              <h3 className="font-headline-md text-headline-md text-on-surface line-clamp-2">
                {claim.subject}
              </h3>
              <p className="font-body-sm text-body-sm text-on-surface-variant line-clamp-2">
                {claim.source_statement}
              </p>
              <div className="flex items-center justify-between mt-auto pt-2 border-t border-outline-variant">
                <StatusBadge status={claim.status} />
                <GenAmount baseUnits={claim.claim_bond_deposited} />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Merges an authoritative batch of claims (`incoming`) into whatever the
 * board already had (`prev`), keyed by id. `incoming` wins on conflict —
 * used both for a fresh cache poll (cache always supersedes a stale
 * chain-only placeholder once the indexer catches up to that id) and for
 * the chain-reconciliation fallback (chain data wins over nothing, since
 * `prev` never has an entry for a still-uncached id). Sorted newest-id-first
 * to match the backend's `createdAt desc` ordering.
 */
function mergeClaims(incoming: Claim[], prev: Claim[] | null): Claim[] {
  const byId = new Map<string, Claim>();
  for (const claim of prev ?? []) byId.set(claim.id, claim);
  for (const claim of incoming) byId.set(claim.id, claim);
  return [...byId.values()].sort((a, b) => Number(b.id) - Number(a.id));
}
