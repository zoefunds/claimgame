"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet } from "@/lib/api";
import { usePolling } from "@/lib/use-polling";

const POLL_INTERVAL_MS = 15_000;

type LeaderboardEntry = {
  walletAddress: string;
  rank: number;
  scoreValue: number;
};

const CATEGORIES = [
  { key: "INTERPRETER", label: "Top Interpreters" },
  { key: "DETECTIVE", label: "Top Detectives" },
  { key: "EVIDENCE_HUNTER", label: "Top Evidence Hunters" },
] as const;

const CURRENT_SEASON = "1";

/** Reads from the backend's reputation-cache API (docs/architecture.md §11,
 * §16) — reputation is deliberately an off-chain analytics product computed
 * from indexed reputation_events, not contract state, so it can be
 * recomputed cheaply without touching the contract. */
export default function LeaderboardPage() {
  const [data, setData] = useState<Record<string, LeaderboardEntry[]>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const results = await Promise.all(
        CATEGORIES.map((c) =>
          apiGet<LeaderboardEntry[]>(`/api/v1/leaderboard?seasonId=${CURRENT_SEASON}&category=${c.key}`),
        ),
      );
      setData(Object.fromEntries(CATEGORIES.map((c, i) => [c.key, results[i]])));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load leaderboard");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  usePolling(load, POLL_INTERVAL_MS);

  return (
    <div className="p-container-padding md:p-8 max-w-7xl mx-auto w-full space-y-8">
      <header className="border-b border-outline-variant pb-6">
        <div className="font-data-label text-data-label text-primary tracking-widest mb-1">LIVE PROTOCOL</div>
        <h1 className="font-headline-lg text-headline-lg text-on-surface uppercase">Season 01: The Architects</h1>
      </header>

      {error && (
        <div className="border border-error/30 bg-error/10 text-error p-4 rounded font-code-sm text-code-sm">
          {error} — the indexer/backend may not be running yet.
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {CATEGORIES.map((category) => (
          <div key={category.key} className="bg-surface border border-outline-variant flex flex-col">
            <div className="p-3 border-b border-outline-variant bg-surface-container-low">
              <h3 className="font-body-md text-body-md font-semibold text-on-surface">{category.label}</h3>
            </div>
            <div className="flex flex-col">
              {(data[category.key] ?? []).map((entry) => (
                <div key={entry.walletAddress} className="flex items-center px-3 py-2 border-b border-outline-variant/30">
                  <div className="w-8 font-code-sm text-code-sm text-primary">{entry.rank.toString().padStart(2, "0")}</div>
                  <div className="flex-1 font-body-sm text-body-sm text-on-surface-variant truncate pl-2">
                    {entry.walletAddress}
                  </div>
                  <div className="font-code-sm text-code-sm text-on-surface">{entry.scoreValue.toFixed(1)}</div>
                </div>
              ))}
              {!data[category.key] && !error && (
                <div className="p-4 text-on-surface-variant font-body-sm text-body-sm animate-pulse">Loading…</div>
              )}
              {data[category.key]?.length === 0 && (
                <div className="p-4 text-on-surface-variant font-body-sm text-body-sm">No entries yet this season.</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
