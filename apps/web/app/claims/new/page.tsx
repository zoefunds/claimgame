"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { contractReads, contractWrites } from "@/lib/contract";
import type { TxStatus, Difficulty } from "@/lib/types";
import { TxStatusBanner } from "@/components/TxStatusBanner";
import { RequireWallet } from "@/components/RequireWallet";
import { useWallet } from "@/lib/wallet-context";

const DIFFICULTIES: Difficulty[] = ["EASY", "AMBIGUOUS", "HARD", "EXTREME"];

/** create_claim() is payable — the bond is read on-chain only from
 * gl.message.value, so this form's "Bond (GEN)" field is what actually gets
 * sent as tx value, never a separate parameter. */
export default function CreateClaimPage() {
  return (
    <div className="p-container-padding md:p-8 max-w-2xl mx-auto w-full">
      <h1 className="font-headline-lg text-headline-lg text-on-surface mb-1">New Claim</h1>
      <p className="font-body-sm text-body-sm text-on-surface-variant mb-8">
        Your bond is locked in the contract the moment you sign — set it deliberately.
      </p>
      <RequireWallet>
        <CreateClaimForm />
      </RequireWallet>
    </div>
  );
}

function CreateClaimForm() {
  const router = useRouter();
  const { address } = useWallet();
  const [status, setStatus] = useState<TxStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [form, setForm] = useState({
    protocol: "",
    category: "Protocol Claims",
    subject: "",
    sourceStatement: "",
    interpretation: "",
    difficulty: "AMBIGUOUS" as Difficulty,
    challengeWindowSeconds: 60 * 60 * 24 * 3,
    bondGen: "10",
  });

  const update = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    if (!address) {
      setErrorMessage("Wallet disconnected — reconnect and try again.");
      return;
    }
    try {
      await contractWrites.createClaim(address, form, setStatus);
      // create_claim's return value (the new claim id) isn't reliably
      // exposed on the transaction receipt in genlayer-js@1.1.8 (see
      // lib/contract.ts writeAndTrack for why) — ids are sequential
      // u256 counters starting at 1, so the just-created claim's id is the
      // current total count.
      const count = await contractReads.getClaimCount();
      router.push(`/claims/${count}`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to create claim");
    }
  };

  return (
    <>
      <form onSubmit={submit} className="flex flex-col gap-5">
        <Field label="Protocol">
          <input
            required
            value={form.protocol}
            onChange={(e) => update("protocol", e.target.value)}
            className="input"
            placeholder="e.g. Uniswap V4"
          />
        </Field>

        <Field label="Category">
          <input
            required
            value={form.category}
            onChange={(e) => update("category", e.target.value)}
            className="input"
          />
        </Field>

        <Field label="Subject">
          <input
            required
            value={form.subject}
            onChange={(e) => update("subject", e.target.value)}
            className="input"
            placeholder="e.g. Liquidity withdrawals"
          />
        </Field>

        <Field label="Source Statement">
          <textarea
            required
            value={form.sourceStatement}
            onChange={(e) => update("sourceStatement", e.target.value)}
            className="input min-h-24"
            placeholder="What the protocol actually said, verbatim."
          />
        </Field>

        <Field label="Canonical Interpretation">
          <textarea
            required
            value={form.interpretation}
            onChange={(e) => update("interpretation", e.target.value)}
            className="input min-h-24"
            placeholder="What you believe that statement means."
          />
        </Field>

        <Field label="Difficulty">
          <select
            value={form.difficulty}
            onChange={(e) => update("difficulty", e.target.value as Difficulty)}
            className="input"
          >
            {DIFFICULTIES.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Challenge Window (hours)">
          <input
            type="number"
            min={6}
            max={720}
            value={form.challengeWindowSeconds / 3600}
            onChange={(e) => update("challengeWindowSeconds", Number(e.target.value) * 3600)}
            className="input"
          />
        </Field>

        <Field label="Bond (GEN) — minimum 10">
          <input
            required
            value={form.bondGen}
            onChange={(e) => update("bondGen", e.target.value)}
            className="input font-code-sm"
          />
        </Field>

        <TxStatusBanner status={status} />
        {errorMessage && (
          <div className="text-error font-code-sm text-code-sm border border-error/30 bg-error/10 p-3 rounded">
            {errorMessage}
          </div>
        )}

        <button
          type="submit"
          disabled={status !== "idle" && status !== "rejected" && status !== "failed"}
          className="bg-primary text-on-primary py-3 rounded font-data-label text-data-label uppercase tracking-widest hover:bg-primary-fixed-dim transition-colors disabled:opacity-50"
        >
          Submit Case for Judgment Eligibility
        </button>
      </form>

      <style jsx global>{`
        .input {
          background: theme("colors.surface-container-lowest");
          border: 1px solid theme("colors.outline-variant");
          border-radius: 0.25rem;
          padding: 0.5rem 0.75rem;
          color: theme("colors.on-surface");
          font-family: inherit;
          width: 100%;
        }
        .input:focus {
          outline: none;
          border-color: theme("colors.primary-container");
        }
      `}</style>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-data-label text-data-label text-on-surface-variant uppercase tracking-wider">
        {label}
      </span>
      {children}
    </label>
  );
}
