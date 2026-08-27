"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { contractReads, contractWrites } from "@/lib/contract";
import { apiGet } from "@/lib/api";
import type {
  BackendClaim,
  Claim,
  ClaimVersion,
  Evidence,
  Challenge,
  Resolution,
  Appeal,
  TxStatus,
} from "@/lib/types";
import {
  mapBackendClaim,
  mapBackendClaimVersion,
  mapBackendEvidence,
  mapBackendChallenge,
  mapBackendResolution,
  mapBackendAppeal,
} from "@/lib/types";
import { DifficultyBadge, StatusBadge, GenAmount } from "@/components/Badges";
import { TxStatusBanner } from "@/components/TxStatusBanner";
import { RequireWallet } from "@/components/RequireWallet";
import { useWallet } from "@/lib/wallet-context";
import { usePolling } from "@/lib/use-polling";

const LIVE_POLL_INTERVAL_MS = 10_000;

type ClaimData = {
  claim: Claim;
  versions: ClaimVersion[];
  evidence: Evidence[];
  challenge: Challenge | null;
  resolution: Resolution | null;
  appeal: Appeal | null;
};

/**
 * The investigative case-file screen — the one place that exercises nearly
 * every write method on the deployed contract:
 * submit_evidence, raise_objection, submit_challenge, submit_for_judgment,
 * withdraw_claim, claim_expired, propose_human_settlement,
 * claim_dispute_timeout, amend_claim. Each action panel only renders when
 * the claim's on-chain status actually allows that call, so a disabled
 * button never masks a transaction that would just revert.
 */
export default function ClaimDetailPage() {
  const params = useParams<{ id: string }>();
  const claimId = params.id;

  const [data, setData] = useState<ClaimData | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * Polling reads from the backend cache (`GET /api/v1/claims/:id`), not
   * directly from GenLayer — see app/claims/page.tsx's module docstring:
   * every open tab polling StudioNet's shared RPC every 10s multiplies
   * with concurrent viewers and risks its rate limit, while polling our
   * own Fly-hosted API doesn't touch GenLayer at all. The indexer keeps
   * this within ~5s of the contract.
   */
  const reload = useCallback(async () => {
    try {
      const row = await apiGet<BackendClaim>(`/api/v1/claims/${claimId}`);
      setData({
        claim: mapBackendClaim(row),
        versions: (row.versions ?? []).map(mapBackendClaimVersion),
        evidence: (row.evidence ?? []).map(mapBackendEvidence),
        challenge: row.challenge ? mapBackendChallenge(row.challenge) : null,
        resolution: row.resolution ? mapBackendResolution(row.resolution) : null,
        appeal: row.appeal ? mapBackendAppeal(row.appeal) : null,
      });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load claim");
    }
  }, [claimId]);

  /**
   * Direct-from-contract, single-claim read — used ONLY right after this
   * user's own transaction finalizes (see `ActionPanel`'s `onDone`), so
   * they see their own action reflected immediately instead of waiting up
   * to one indexer cycle (~5s). This is a handful of one-off calls tied to
   * a user action, not a standing poll loop, so it doesn't carry the same
   * rate-limit exposure as continuous background polling would.
   */
  const reloadFromChain = useCallback(async () => {
    try {
      const [claim, versions, evidence] = await Promise.all([
        contractReads.getClaim(claimId) as Promise<Claim>,
        contractReads.listClaimVersions(claimId) as Promise<ClaimVersion[]>,
        contractReads.listEvidenceForClaim(claimId) as Promise<Evidence[]>,
      ]);

      let challenge: Challenge | null = null;
      try {
        challenge = (await contractReads.getChallenge(claimId)) as Challenge;
      } catch {
        challenge = null;
      }

      let resolution: Resolution | null = null;
      try {
        resolution = (await contractReads.getResolution(claimId)) as Resolution;
      } catch {
        resolution = null;
      }

      let appeal: Appeal | null = null;
      try {
        appeal = (await contractReads.getAppeal(claimId)) as Appeal | null;
      } catch {
        appeal = null;
      }

      setData({ claim, versions, evidence, challenge, resolution, appeal });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load claim");
    }
  }, [claimId]);

  useEffect(() => {
    reload();
  }, [reload]);

  usePolling(reload, LIVE_POLL_INTERVAL_MS);

  if (error) {
    return <div className="p-8 text-error font-code-sm text-code-sm">{error}</div>;
  }
  if (!data) {
    return <div className="p-8 animate-pulse text-on-surface-variant">Loading claim #{claimId}…</div>;
  }

  const { claim, versions, evidence, challenge, resolution, appeal } = data;
  const currentVersion = versions.find((v) => v.version === claim.current_version) ?? versions[versions.length - 1];

  return (
    <div className="p-container-padding md:p-8 max-w-7xl mx-auto w-full space-y-8">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-outline-variant pb-6">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <span className="font-code-sm text-code-sm text-primary bg-primary/10 px-2 py-0.5 rounded border border-primary/20">
              CLAIM #{claim.id}
            </span>
            <DifficultyBadge difficulty={claim.difficulty} />
          </div>
          <h1 className="font-headline-lg text-headline-lg text-on-surface">{claim.subject}</h1>
        </div>
        <div className="flex flex-col items-end gap-2">
          <StatusBadge status={claim.status} />
          <div className="font-code-sm text-code-sm text-on-surface-variant">
            BOND: <GenAmount baseUnits={claim.claim_bond_deposited} />
          </div>
        </div>
      </header>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 items-start">
        <div className="xl:col-span-2 space-y-8">
          <Section title="Core Discrepancy">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Panel label="SOURCE STATEMENT">{claim.source_statement}</Panel>
              <Panel label={`CANONICAL INTERPRETATION (v${currentVersion?.version ?? 1})`}>
                {currentVersion?.interpretation}
              </Panel>
            </div>
          </Section>

          <Section title={`Evidence Board (${evidence.length})`}>
            <div className="space-y-2">
              {evidence.map((item) => (
                <div key={item.id} className="p-3 bg-surface-container-low border border-outline-variant rounded">
                  <div className="flex justify-between items-center mb-1">
                    <span className="font-data-label text-data-label text-primary">{item.evidence_type}</span>
                    <span className="font-data-label text-data-label text-on-surface-variant">{item.side}</span>
                  </div>
                  <p className="font-body-sm text-body-sm text-on-surface">{item.description}</p>
                  {item.url && (
                    <a href={item.url} target="_blank" rel="noreferrer" className="font-code-sm text-code-sm text-outline truncate block mt-1">
                      {item.url}
                    </a>
                  )}
                  {item.retrieved_at ? (
                    <div className="mt-1 space-y-1">
                      <div className="font-code-sm text-code-sm text-primary/70" title={`content hash ${item.content_hash}`}>
                        ✓ verified by contract fetch · {new Date(item.retrieved_at).toLocaleString()}
                      </div>
                      {item.snapshot_text && (
                        <div className="font-code-sm text-code-sm text-on-surface-variant bg-surface-container-lowest border border-outline-variant rounded p-2 whitespace-pre-wrap">
                          &ldquo;{item.snapshot_text}&rdquo;
                        </div>
                      )}
                      {item.full_page_hash && (
                        <div className="font-code-sm text-code-sm text-on-surface-variant/60 truncate" title={item.full_page_hash}>
                          full-page fingerprint (SHA-256): {item.full_page_hash}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="font-code-sm text-code-sm text-on-surface-variant/60 mt-1">
                      not yet fetched by the contract
                    </div>
                  )}
                </div>
              ))}
              {evidence.length === 0 && (
                <p className="text-on-surface-variant font-body-sm text-body-sm">No evidence submitted yet.</p>
              )}
            </div>
          </Section>

          {resolution && (
            <Section title="GenLayer Judgment">
              <div className="bg-surface-container-low border border-outline-variant rounded p-4 space-y-2">
                <div className="font-headline-md text-headline-md text-primary">{resolution.verdict}</div>
                <div className="font-data-label text-data-label text-on-surface-variant">
                  CONFIDENCE: {resolution.confidence} · PAYOUT: {resolution.payout_bps / 100}% to claimant
                </div>
                <p className="font-body-sm text-body-sm text-on-surface">{resolution.reasoning_summary}</p>
                <p className="font-body-sm text-body-sm text-on-surface-variant italic">
                  This verdict was produced by an LLM under validator consensus — treat it as a strong
                  signal, not an infallible ruling.
                </p>
              </div>
            </Section>
          )}

          {appeal && (
            <Section title="Appeal">
              <div className="bg-surface-container-low border border-outline-variant rounded p-4 space-y-2">
                <div className="font-headline-md text-headline-md text-primary">{appeal.outcome.replace(/_/g, " ")}</div>
                <div className="font-data-label text-data-label text-on-surface-variant">
                  ORIGINAL: {appeal.original_verdict} ({appeal.original_payout_bps / 100}%) · APPEAL ROUND:{" "}
                  {appeal.appeal_verdict} ({appeal.appeal_payout_bps / 100}%)
                </div>
                <p className="font-body-sm text-body-sm text-on-surface-variant">
                  Appellant: <span className="font-code-sm text-on-surface">{appeal.appellant}</span> · bond{" "}
                  <GenAmount baseUnits={appeal.appeal_bond_wei} />
                </p>
                <p className="font-body-sm text-body-sm text-on-surface-variant">
                  {appeal.outcome === "OVERTURNED"
                    ? "The independent second judgment round changed the outcome — the appellant's bond was refunded and this verdict replaced the original."
                    : appeal.outcome === "UPHELD_ORIGINAL"
                      ? "The independent second judgment round reached the same verdict — the appellant's bond was forfeited to the other party."
                      : "The appeal round itself was inconclusive, so the original verdict stands and the appellant's bond was refunded in full."}
                </p>
              </div>
            </Section>
          )}
        </div>

        <aside className="space-y-4">
          <RequireWallet>
            <ActionPanel claim={claim} challenge={challenge} onDone={reloadFromChain} />
          </RequireWallet>
        </aside>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <h3 className="font-data-label text-data-label text-outline uppercase tracking-widest">{title}</h3>
      {children}
    </section>
  );
}

function Panel({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface-container border border-outline-variant rounded p-4">
      <div className="font-data-label text-data-label text-on-surface-variant mb-3">{label}</div>
      <div className="font-code-sm text-code-sm text-on-surface whitespace-pre-wrap leading-relaxed">
        {children}
      </div>
    </div>
  );
}

function ActionPanel({
  claim,
  challenge,
  onDone,
}: {
  claim: Claim;
  challenge: Challenge | null;
  onDone: () => void;
}) {
  const { address } = useWallet();
  const [status, setStatus] = useState<TxStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [evidence, setEvidence] = useState({ evidenceType: "URL", url: "", description: "", side: "SUPPORT" as const });
  const [challengeArg, setChallengeArg] = useState("");
  const [stakeGen, setStakeGen] = useState("10");
  const [objectionText, setObjectionText] = useState("");
  const [settlementBps, setSettlementBps] = useState(5000);

  // ActionPanel only renders inside <RequireWallet>, so `address` is
  // non-null in practice — this guard exists for the disconnect-mid-session
  // edge case (e.g. the user disconnects in MetaMask while this panel is
  // still mounted).
  const run = async (action: (account: `0x${string}`) => Promise<unknown>) => {
    setErrorMessage(null);
    if (!address) {
      setErrorMessage("Wallet disconnected — reconnect and try again.");
      return;
    }
    try {
      await action(address);
      await onDone();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Transaction failed");
    }
  };

  return (
    <div className="space-y-4">
      <TxStatusBanner status={status} />
      {errorMessage && (
        <div className="text-error font-code-sm text-code-sm border border-error/30 bg-error/10 p-3 rounded">
          {errorMessage}
        </div>
      )}

      {claim.status === "OPEN" && (
        <div className="bg-surface border border-outline-variant rounded p-4 space-y-3">
          <h4 className="font-data-label text-data-label text-on-surface">Challenge Interpretation</h4>
          <textarea
            className="input min-h-20"
            placeholder="What contradicts this interpretation?"
            value={challengeArg}
            onChange={(e) => setChallengeArg(e.target.value)}
          />
          <input className="input font-code-sm" value={stakeGen} onChange={(e) => setStakeGen(e.target.value)} />
          <button
            className="btn-primary"
            onClick={() => run((account) => contractWrites.submitChallenge(account, claim.id, challengeArg, stakeGen, setStatus))}
          >
            Submit Challenge
          </button>
          <button
            className="btn-ghost"
            onClick={() => run((account) => contractWrites.withdrawClaim(account, claim.id, setStatus))}
          >
            Withdraw Claim (before challenge)
          </button>
          <button
            className="btn-ghost"
            onClick={() => run((account) => contractWrites.claimExpired(account, claim.id, setStatus))}
          >
            Claim Expired (after window closes)
          </button>
        </div>
      )}

      {(claim.status === "OPEN" || claim.status === "CHALLENGED" || claim.status === "UNDER_REVIEW") && (
        <div className="bg-surface border border-outline-variant rounded p-4 space-y-3">
          <h4 className="font-data-label text-data-label text-on-surface">Submit Evidence</h4>
          <select className="input" value={evidence.evidenceType} onChange={(e) => setEvidence((s) => ({ ...s, evidenceType: e.target.value }))}>
            {["URL", "PROTOCOL_DOCUMENTATION", "GOVERNANCE_PROPOSAL", "BLOCKCHAIN_TRANSACTION", "OFFICIAL_ANNOUNCEMENT", "FORUM_DISCUSSION", "SOCIAL_POST", "SCREENSHOT", "OTHER"].map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <input className="input" placeholder="https://…" value={evidence.url} onChange={(e) => setEvidence((s) => ({ ...s, url: e.target.value }))} />
          <textarea className="input min-h-16" placeholder="Description" value={evidence.description} onChange={(e) => setEvidence((s) => ({ ...s, description: e.target.value }))} />
          <button
            className="btn-primary"
            onClick={() =>
              run((account) =>
                contractWrites.submitEvidence(
                  account,
                  { claimId: claim.id, evidenceType: evidence.evidenceType, url: evidence.url, description: evidence.description, side: evidence.side },
                  setStatus,
                ),
              )
            }
          >
            Submit Evidence
          </button>

          <h4 className="font-data-label text-data-label text-on-surface pt-2">Raise Objection</h4>
          <textarea className="input min-h-16" value={objectionText} onChange={(e) => setObjectionText(e.target.value)} />
          <button className="btn-ghost" onClick={() => run((account) => contractWrites.raiseObjection(account, claim.id, objectionText, setStatus))}>
            Raise Objection
          </button>
        </div>
      )}

      {claim.status === "CHALLENGED" && challenge && (
        <div className="bg-surface border border-outline-variant rounded p-4 space-y-3">
          <h4 className="font-data-label text-data-label text-on-surface">Submit Case for Judgment</h4>
          <p className="font-body-sm text-body-sm text-on-surface-variant">
            Triggers GenLayer's contract-side evidence fetch and validator consensus.
          </p>
          <button className="btn-primary" onClick={() => run((account) => contractWrites.submitForJudgment(account, claim.id, setStatus))}>
            Submit for Judgment
          </button>
        </div>
      )}

      {claim.status === "PENDING_APPEAL" && (
        <PendingAppealBlock claim={claim} challenge={challenge} address={address} run={run} />
      )}

      {claim.status === "NEEDS_HUMAN_REVIEW" && (
        <div className="bg-surface border border-outline-variant rounded p-4 space-y-3">
          <h4 className="font-data-label text-data-label text-on-surface">Needs Human Review</h4>
          <p className="font-body-sm text-body-sm text-on-surface-variant">
            Propose a payout split (0–10000 bps to the claimant). If both parties propose the same
            value, it settles automatically. After the review deadline, either party can trigger
            the timeout recovery instead.
          </p>
          <input
            type="number"
            min={0}
            max={10000}
            className="input font-code-sm"
            value={settlementBps}
            onChange={(e) => setSettlementBps(Number(e.target.value))}
          />
          <button className="btn-primary" onClick={() => run((account) => contractWrites.proposeHumanSettlement(account, claim.id, settlementBps, setStatus))}>
            Propose Settlement
          </button>
          <button className="btn-ghost" onClick={() => run((account) => contractWrites.claimDisputeTimeout(account, claim.id, setStatus))}>
            Claim Dispute Timeout Refund
          </button>
        </div>
      )}

      <style jsx global>{`
        .input {
          background: theme("colors.surface-container-lowest");
          border: 1px solid theme("colors.outline-variant");
          border-radius: 0.25rem;
          padding: 0.5rem 0.75rem;
          color: theme("colors.on-surface");
          width: 100%;
        }
        .btn-primary {
          width: 100%;
          background: theme("colors.primary");
          color: theme("colors.on-primary");
          padding: 0.5rem;
          border-radius: 0.25rem;
          font-family: "JetBrains Mono", monospace;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .btn-ghost {
          width: 100%;
          background: transparent;
          color: theme("colors.on-surface-variant");
          border: 1px solid theme("colors.outline-variant");
          padding: 0.5rem;
          border-radius: 0.25rem;
          font-family: "JetBrains Mono", monospace;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
      `}</style>
    </div>
  );
}

/**
 * v0.3.6: a determinate verdict no longer settles funds immediately — it
 * sits in a 24h PENDING_APPEAL window first (see contract.py's
 * _apply_verdict / raise_appeal / finalize_settlement). Either the
 * claimant or the challenger can spend that window to force one fresh,
 * independent GenVM judgment round (raise_appeal, real 10 GEN bond); if
 * nobody appeals, anyone can call finalize_settlement once the window
 * closes to actually move the funds — permissionless, same pattern as
 * claim_dispute_timeout elsewhere in this file.
 */
function PendingAppealBlock({
  claim,
  challenge,
  address,
  run,
}: {
  claim: Claim;
  challenge: Challenge | null;
  address: `0x${string}` | null | undefined;
  run: (action: (account: `0x${string}`) => Promise<unknown>) => Promise<void>;
}) {
  const [status, setStatus] = useState<TxStatus>("idle");
  const [now, setNow] = useState(() => Date.now());
  const [appealEvidence, setAppealEvidence] = useState({ evidenceType: "URL", url: "", description: "" });

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const deadlineMs = claim.appeal_deadline ? new Date(claim.appeal_deadline).getTime() : null;
  const windowOpen = deadlineMs !== null && now < deadlineMs;
  const remainingMs = deadlineMs !== null ? Math.max(0, deadlineMs - now) : 0;
  const remainingLabel = formatRemaining(remainingMs);

  const isParty =
    !!address &&
    (address.toLowerCase() === claim.creator.toLowerCase() ||
      (!!challenge && address.toLowerCase() === challenge.challenger.toLowerCase()));

  return (
    <div className="bg-surface border border-outline-variant rounded p-4 space-y-3">
      <h4 className="font-data-label text-data-label text-on-surface">Pending Appeal Window</h4>
      <p className="font-body-sm text-body-sm text-on-surface-variant">
        A verdict was reached but funds have not moved yet — either party can force one fresh,
        independent judgment round before the window closes.
      </p>
      <div className="font-code-sm text-code-sm text-on-surface bg-surface-container-low border border-outline-variant rounded p-3 space-y-1">
        <div>PENDING VERDICT: {claim.pending_verdict ?? "—"}</div>
        <div>PENDING PAYOUT: {claim.pending_payout_bps != null ? `${claim.pending_payout_bps / 100}% to claimant` : "—"}</div>
        <div>{windowOpen ? `APPEAL WINDOW CLOSES IN: ${remainingLabel}` : "APPEAL WINDOW CLOSED — ready to finalize"}</div>
      </div>

      <TxStatusBanner status={status} />

      {windowOpen ? (
        isParty ? (
          <>
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              Optionally submit one new piece of evidence specifically for the appeal round — it will be
              fetched and guaranteed to be considered, independent of the original evidence pool.
            </p>
            <select
              className="input"
              value={appealEvidence.evidenceType}
              onChange={(e) => setAppealEvidence((s) => ({ ...s, evidenceType: e.target.value }))}
            >
              {["URL", "PROTOCOL_DOCUMENTATION", "GOVERNANCE_PROPOSAL", "BLOCKCHAIN_TRANSACTION", "OFFICIAL_ANNOUNCEMENT", "FORUM_DISCUSSION", "SOCIAL_POST", "SCREENSHOT", "OTHER"].map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <input
              className="input"
              placeholder="https://… (optional — leave blank to appeal without new evidence)"
              value={appealEvidence.url}
              onChange={(e) => setAppealEvidence((s) => ({ ...s, url: e.target.value }))}
            />
            <textarea
              className="input min-h-16"
              placeholder="Description (required only if a URL is provided)"
              value={appealEvidence.description}
              onChange={(e) => setAppealEvidence((s) => ({ ...s, description: e.target.value }))}
            />
            <button
              className="btn-primary"
              onClick={() => run((account) => contractWrites.raiseAppeal(account, claim.id, appealEvidence, setStatus))}
            >
              Raise Appeal (10 GEN bond)
            </button>
          </>
        ) : (
          <p className="font-code-sm text-code-sm text-on-surface-variant/60">
            Only the claimant or the challenger may raise an appeal on this claim.
          </p>
        )
      ) : (
        <button
          className="btn-primary"
          onClick={() => run((account) => contractWrites.finalizeSettlement(account, claim.id, setStatus))}
        >
          Finalize Settlement
        </button>
      )}
    </div>
  );
}

function formatRemaining(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h ${minutes}m ${seconds}s`;
}
