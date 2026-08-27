"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet } from "@/lib/api";
import { RequireWallet } from "@/components/RequireWallet";
import { useWallet } from "@/lib/wallet-context";

const POLL_INTERVAL_MS = 15_000;

type BackendReputationEvent = {
  user: string;
  claimId: string;
  role: "CLAIMANT" | "CHALLENGER" | "EVIDENCE";
  outcome: string;
  stakeWeight: string;
  occurredAt: string;
};

type ReputationScore = {
  interpretationAccuracy: number;
  challengeAccuracy: number;
  evidenceReliability: number;
  progressionTier: string;
} | null;

export default function ProfilePage() {
  return (
    <div className="p-container-padding md:p-8 max-w-3xl mx-auto w-full space-y-6">
      <h1 className="font-headline-lg text-headline-lg text-on-surface mb-1">Profile</h1>
      <RequireWallet>
        <ProfileContent />
      </RequireWallet>
    </div>
  );
}

/**
 * Both the raw event log and the aggregated score come from the backend
 * cache — not from a direct `get_reputation_events_for_user` contract call
 * on every poll. A per-profile-view contract call is lower-volume than
 * Hunt Board's list-everything pattern, but it's still an unbounded number
 * of browser tabs hitting GenLayer's shared StudioNet RPC directly on a
 * timer; the backend's indexer already re-derives this from the same
 * on-chain events every ~5s (apps/api/src/indexer/index.ts), so there's no
 * freshness cost to reading it from there instead.
 */
function ProfileContent() {
  const { address } = useWallet();
  const [events, setEvents] = useState<BackendReputationEvent[] | null>(null);
  const [score, setScore] = useState<ReputationScore>(null);
  const [scoreError, setScoreError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!address) return;
    try {
      const rows = await apiGet<BackendReputationEvent[]>(`/api/v1/reputation/${address}/events`);
      setEvents(rows);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load reputation events");
    }

    try {
      const cached = await apiGet<ReputationScore>(`/api/v1/reputation/${address}`);
      setScore(cached);
      setScoreError(null);
    } catch (err) {
      setScoreError(err instanceof Error ? err.message : "Backend cache unreachable");
    }
  }, [address]);

  useEffect(() => {
    load();
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [load]);

  if (error) {
    return <div className="border border-error/30 bg-error/10 text-error p-4 rounded font-code-sm text-code-sm">{error}</div>;
  }

  return (
    <div className="space-y-6">
      <div className="font-code-sm text-code-sm text-on-surface-variant">{address}</div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatBlock label="Interpretation Accuracy" value={score ? `${(score.interpretationAccuracy * 100).toFixed(0)}%` : "—"} />
        <StatBlock label="Challenge Accuracy" value={score ? `${(score.challengeAccuracy * 100).toFixed(0)}%` : "—"} />
        <StatBlock label="Progression Tier" value={score?.progressionTier ?? "NOVICE"} />
      </div>
      {scoreError && (
        <p className="font-code-sm text-code-sm text-tertiary-container">
          Aggregated score cache unavailable ({scoreError}) — raw event log below is still live from the
          contract.
        </p>
      )}

      <div>
        <h3 className="font-data-label text-data-label text-outline uppercase tracking-widest mb-3">
          Reputation Events ({events?.length ?? 0})
        </h3>
        {!events && <p className="text-on-surface-variant font-body-sm text-body-sm animate-pulse">Loading…</p>}
        {events?.length === 0 && (
          <p className="text-on-surface-variant font-body-sm text-body-sm">No activity recorded yet.</p>
        )}
        <div className="space-y-2">
          {events?.map((e, i) => (
            <div key={i} className="flex items-center justify-between p-3 bg-surface-container-low border border-outline-variant rounded">
              <div className="flex items-center gap-3">
                <span className="font-data-label text-data-label text-primary">{e.role}</span>
                <span className="font-code-sm text-code-sm text-on-surface-variant">Claim #{e.claimId}</span>
              </div>
              <span className="font-data-label text-data-label text-on-surface-variant">{e.outcome}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StatBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface-container-low border border-outline-variant rounded p-4">
      <div className="font-data-label text-data-label text-on-surface-variant mb-1">{label}</div>
      <div className="font-headline-md text-headline-md text-on-surface">{value}</div>
    </div>
  );
}
