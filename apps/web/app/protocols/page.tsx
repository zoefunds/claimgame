"use client";

import { useCallback, useEffect, useState } from "react";
import { contractReads, contractWrites } from "@/lib/contract";
import type { TxStatus } from "@/lib/types";
import { TxStatusBanner } from "@/components/TxStatusBanner";
import { RequireWallet } from "@/components/RequireWallet";
import { useWallet } from "@/lib/wallet-context";

type ProtocolRecord = { category: string; official_domains: string[] };

type DomainProposal = {
  id: string;
  protocol: string;
  domain: string;
  github_org: string;
  proposer: string;
  status: "PROPOSED" | "VERIFIED" | "REJECTED";
  verification_result?: string;
  created_at: string;
  resolved_at: string | null;
};

/**
 * v0.3.10 — the protocol registry, and the validator-verified official-
 * domain flow that replaces the owner-only set_protocol_official_domains
 * gate: anyone can PROPOSE a domain is official for a protocol (bonded);
 * whether it's ACCEPTED is decided by GenVM validator consensus
 * (verify_official_domain), not by a human. This page is read directly
 * from the contract (not the backend cache) since it's a low-traffic,
 * infrequently-changing registry, not something that needs indexer
 * caching the way high-volume claim data does.
 */
export default function ProtocolsPage() {
  const [protocols, setProtocols] = useState<Record<string, ProtocolRecord>>({});
  const [error, setError] = useState<string | null>(null);
  const [lastProposalId, setLastProposalId] = useState<string | null>(null);
  const [lastProposal, setLastProposal] = useState<DomainProposal | null>(null);

  const load = useCallback(async () => {
    try {
      const result = (await contractReads.listProtocols()) as unknown as Record<string, ProtocolRecord>;
      setProtocols(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load protocol registry");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const refreshProposal = useCallback(async (proposalId: string) => {
    try {
      const p = (await contractReads.getDomainProposal(proposalId)) as unknown as DomainProposal;
      setLastProposal(p);
    } catch {
      setLastProposal(null);
    }
  }, []);

  return (
    <div className="p-container-padding md:p-8 max-w-7xl mx-auto w-full space-y-8">
      <header className="border-b border-outline-variant pb-6">
        <div className="font-data-label text-data-label text-primary tracking-widest mb-1">SOURCE TRUST</div>
        <h1 className="font-headline-lg text-headline-lg text-on-surface">Protocol Registry</h1>
        <p className="font-body-sm text-body-sm text-on-surface-variant mt-2 max-w-2xl">
          Evidence submitted under PROTOCOL_DOCUMENTATION / GOVERNANCE_PROPOSAL / OFFICIAL_ANNOUNCEMENT only
          counts as VERIFIED_PRIMARY when its URL matches a domain here — and getting a domain onto this list
          isn&apos;t an admin decision. Anyone can propose one; GenVM validators independently check it against
          the protocol&apos;s public GitHub organization and reach consensus, the same way a claim&apos;s verdict is reached.
        </p>
      </header>

      {error && (
        <div className="border border-error/30 bg-error/10 text-error p-4 rounded font-code-sm text-code-sm">
          {error}
        </div>
      )}

      <section className="space-y-4">
        <h3 className="font-data-label text-data-label text-outline uppercase tracking-widest">Registered Protocols</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {Object.entries(protocols).map(([name, record]) => (
            <div key={name} className="bg-surface-container-low border border-outline-variant rounded p-4">
              <div className="flex justify-between items-center mb-2">
                <span className="font-body-md text-body-md font-semibold text-on-surface">{name}</span>
                <span className="font-data-label text-data-label text-on-surface-variant">{record.category}</span>
              </div>
              {record.official_domains.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {record.official_domains.map((d) => (
                    <span key={d} className="font-code-sm text-code-sm bg-primary/10 text-primary border border-primary/20 rounded px-2 py-0.5">
                      ✓ {d}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="font-code-sm text-code-sm text-on-surface-variant/60">
                  No verified official domain yet — evidence from this protocol is currently PRIMARY_UNVERIFIED.
                </p>
              )}
            </div>
          ))}
          {Object.keys(protocols).length === 0 && !error && (
            <p className="font-body-sm text-body-sm text-on-surface-variant animate-pulse">Loading…</p>
          )}
        </div>
      </section>

      <RequireWallet>
        <ProposeAndVerifyPanel
          protocolNames={Object.keys(protocols)}
          onProposed={(id) => {
            setLastProposalId(id);
            refreshProposal(id);
          }}
          onVerified={load}
          lastProposalId={lastProposalId}
          lastProposal={lastProposal}
          onRefreshProposal={refreshProposal}
        />
      </RequireWallet>
    </div>
  );
}

function ProposeAndVerifyPanel({
  protocolNames,
  onProposed,
  onVerified,
  lastProposalId,
  lastProposal,
  onRefreshProposal,
}: {
  protocolNames: string[];
  onProposed: (proposalId: string) => void;
  onVerified: () => void;
  lastProposalId: string | null;
  lastProposal: { status: string; verification_result?: string; domain: string; github_org: string } | null;
  onRefreshProposal: (proposalId: string) => void;
}) {
  const { address } = useWallet();
  const [status, setStatus] = useState<TxStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [form, setForm] = useState({ protocolName: "", domain: "", githubOrg: "" });
  const [manualProposalId, setManualProposalId] = useState("");

  const run = async (action: (account: `0x${string}`) => Promise<unknown>) => {
    setErrorMessage(null);
    if (!address) {
      setErrorMessage("Wallet disconnected — reconnect and try again.");
      return;
    }
    try {
      await action(address);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Transaction failed");
    }
  };

  return (
    <section className="space-y-6">
      <div className="bg-surface border border-outline-variant rounded p-4 space-y-3 max-w-xl">
        <h4 className="font-data-label text-data-label text-on-surface">Propose an Official Domain (5 GEN bond)</h4>
        <p className="font-body-sm text-body-sm text-on-surface-variant">
          Pick a protocol already registered above (or type a new name — register it first via a claim), the
          domain you believe is official, and the protocol&apos;s GitHub organization handle (e.g. &ldquo;Uniswap&rdquo; for
          github.com/Uniswap). Validators will independently check that org&apos;s public website field against
          your claimed domain.
        </p>
        <input
          className="input"
          list="protocol-names"
          placeholder="Protocol name (e.g. Uniswap v4)"
          value={form.protocolName}
          onChange={(e) => setForm((s) => ({ ...s, protocolName: e.target.value }))}
        />
        <datalist id="protocol-names">
          {protocolNames.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
        <input
          className="input"
          placeholder="Domain (e.g. uniswap.org — no https://)"
          value={form.domain}
          onChange={(e) => setForm((s) => ({ ...s, domain: e.target.value }))}
        />
        <input
          className="input"
          placeholder="GitHub org (e.g. Uniswap)"
          value={form.githubOrg}
          onChange={(e) => setForm((s) => ({ ...s, githubOrg: e.target.value }))}
        />
        <button
          className="btn-primary"
          onClick={() =>
            run(async (account) => {
              await contractWrites.proposeOfficialDomain(account, form, setStatus);
              // Same pattern as create_claim: the write's own return value
              // isn't reliably exposed via genlayer-js, so the id is
              // derived from the sequential counter right after.
              const count = await contractReads.getDomainProposalCount();
              onProposed(String(count));
            })
          }
        >
          Propose Domain
        </button>
      </div>

      <div className="bg-surface border border-outline-variant rounded p-4 space-y-3 max-w-xl">
        <h4 className="font-data-label text-data-label text-on-surface">Verify a Proposal</h4>
        <p className="font-body-sm text-body-sm text-on-surface-variant">
          Anyone can trigger verification once a proposal exists — the outcome is decided by validator
          consensus, not by who calls this.
        </p>
        <input
          className="input"
          placeholder="Proposal id"
          value={manualProposalId || lastProposalId || ""}
          onChange={(e) => setManualProposalId(e.target.value)}
        />
        <button
          className="btn-primary"
          onClick={() => {
            const id = manualProposalId || lastProposalId;
            if (!id) return;
            run(async (account) => {
              await contractWrites.verifyOfficialDomain(account, id, setStatus);
              onRefreshProposal(id);
              onVerified();
            });
          }}
        >
          Verify Proposal
        </button>
        {lastProposal && (
          <div className="font-code-sm text-code-sm bg-surface-container-low border border-outline-variant rounded p-3 space-y-1">
            <div>domain: {lastProposal.domain} · github_org: {lastProposal.github_org}</div>
            <div>
              status:{" "}
              <span
                className={
                  lastProposal.status === "VERIFIED"
                    ? "text-primary"
                    : lastProposal.status === "REJECTED"
                      ? "text-error"
                      : "text-on-surface-variant"
                }
              >
                {lastProposal.status}
              </span>
              {lastProposal.verification_result ? ` (${lastProposal.verification_result})` : ""}
            </div>
          </div>
        )}
      </div>

      <TxStatusBanner status={status} />
      {errorMessage && (
        <div className="text-error font-code-sm text-code-sm border border-error/30 bg-error/10 p-3 rounded max-w-xl">
          {errorMessage}
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
      `}</style>
    </section>
  );
}
