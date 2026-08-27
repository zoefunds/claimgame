"use client";

/**
 * GenLayer contract client — typed wrapper around every public method on
 * the deployed CLAIMGAME contract (contracts/claimgame/contract.py),
 * address/RPC from env only (see lib/env.ts). Built on `genlayer-js`
 * (`createClient`, `readContract`, `writeContract`,
 * `waitForTransactionReceipt`), confirmed against docs.genlayer.com's
 * "Writing to Intelligent Contracts" and API reference pages.
 *
 * Every write here is signed by the connected wallet via
 * `getWalletClient()` (lib/wallet.ts) — the backend never signs a
 * transaction on the user's behalf, per docs/architecture.md §13/§14.
 *
 * All contract state is stored as JSON strings (see contract.py's
 * TreeMap[str, str] design) — every read wrapper below parses that JSON
 * into a typed shape before returning it, so nothing above this file needs
 * to know the on-chain blob format.
 */

import { TransactionStatus } from "genlayer-js/types";
import type { CalldataEncodable } from "genlayer-js/types";
import { getReadClient, getWalletClient } from "./wallet";
import { getContractConfig } from "./env";
import type { TxStatus } from "./types";

export type { TxStatus } from "./types";

const ONE_GEN = 10n ** 18n;

/** Decimal-safe GEN -> base-unit (wei-equivalent) conversion. Never use
 * floating point for money — this only ever does string/bigint math. */
export function parseGen(amount: string): bigint {
  const [whole, fraction = ""] = amount.trim().split(".");
  const paddedFraction = (fraction + "0".repeat(18)).slice(0, 18);
  const wholeUnits = BigInt(whole || "0") * ONE_GEN;
  const fractionUnits = BigInt(paddedFraction || "0");
  return wholeUnits + fractionUnits;
}

export function formatGen(baseUnits: bigint): string {
  const whole = baseUnits / ONE_GEN;
  const fraction = baseUnits % ONE_GEN;
  return `${whole}.${fraction.toString().padStart(18, "0").slice(0, 2)}`;
}

// ---------------------------------------------------------------------------
// Transaction lifecycle — Idle -> Preparing -> Wallet Prompt -> Submitted ->
// Pending -> Confirmed/Finalized -> Success, or Rejected/Failed/Timed
// Out/Unknown. Never reports "success" from a bare tx hash — always polls
// the real GenLayer transaction status via waitForTransactionReceipt.
// See docs/architecture.md §17 and ClaimGame.md's "Transaction UX" section.
// ---------------------------------------------------------------------------

const TX_WAIT_TIMEOUT_MS = 120_000;

/**
 * CONFIRMED BY LIVE TESTING against the deployed contract (see
 * scripts/test-contract.mjs) — genlayer-js@1.1.8's actual runtime receipt
 * shape does NOT match its own TypeScript declarations. This was a real
 * bug: the previous version of this function read `receipt.statusName` /
 * `receipt.txExecutionResultName`, both of which are `undefined` at
 * runtime, so every transaction that reached FINALIZED was reported as
 * "success" even if the contract had actually raised a `gl.vm.UserError`.
 *
 * The real shape:
 *  - `waitForTransactionReceipt()`'s result has `status_name` (snake_case,
 *    not `statusName`) — PENDING/PROPOSING/COMMITTING/REVEALING (in
 *    flight), ACCEPTED, FINALIZED, CANCELED, UNDETERMINED,
 *    VALIDATORS_TIMEOUT/LEADER_TIMEOUT — and no execution-result field at
 *    all.
 *  - Whether the contract call itself raised is only visible via a
 *    follow-up `client.getTransaction({ hash })` call, inside
 *    `consensus_data.validators[].result`. This field is ALSO
 *    inconsistent at runtime — sometimes a bare base64 string, sometimes
 *    an object `{ raw, status: "rollback", payload }` — so checking for
 *    the object shape alone misses real rollbacks (confirmed: the exact
 *    same "Only owner" rejection came back as a bare string in one test
 *    run and as the object in another, for the same contract method).
 *    The reliable signal is the DECODED BYTES themselves: the first byte
 *    is a tag confirmed empirically against the live contract — `0x00`
 *    success, `0x01` rollback (rest of bytes = UTF-8 `gl.vm.UserError`
 *    message), `0x02` "idle" placeholder (validator didn't independently
 *    execute — skip it, not a real result).
 */
function mapStatusName(statusName: string | undefined): TxStatus {
  switch (statusName) {
    case "PENDING":
    case "PROPOSING":
    case "COMMITTING":
    case "REVEALING":
    case "APPEAL_COMMITTING":
    case "APPEAL_REVEALING":
    case "READY_TO_FINALIZE":
      return "pending";
    case "CANCELED":
      return "rejected";
    case "UNDETERMINED":
      return "unknown";
    case "VALIDATORS_TIMEOUT":
    case "LEADER_TIMEOUT":
      return "timed_out";
    case "ACCEPTED":
      return "confirmed";
    case "FINALIZED":
      return "success";
    default:
      return "unknown";
  }
}

type ConsensusVote = { vote?: string; result?: unknown };
type VoteOutcome = { ok: boolean | null; message?: string };

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeVoteResult(raw: unknown): VoteOutcome {
  const base64 = typeof raw === "string" ? raw : (raw as { raw?: string } | undefined)?.raw;
  if (!base64) return { ok: true };
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(base64);
  } catch {
    return { ok: true };
  }
  if (bytes.length === 0) return { ok: true };
  const tag = bytes[0];
  if (tag === 1) {
    const decoded = new TextDecoder().decode(bytes.subarray(1));
    const payloadHint = typeof raw === "object" ? (raw as { payload?: string })?.payload : undefined;
    return { ok: false, message: payloadHint || decoded };
  }
  if (tag === 2) return { ok: null }; // idle placeholder — not a real result
  return { ok: true };
}

/**
 * CONFIRMED BY LIVE TESTING (2026-08-26, real evidence against a raw
 * GitHub markdown URL): the byte-tag decode above is NOT sufficient on its
 * own. A transaction can come back with the outer `status` as "FINALIZED"
 * and every individual validator's `result` byte-tag decoding as
 * "success" (tag 0) or empty, while the validators' actual `vote` field
 * shows a MAJORITY "disagree" — meaning the validators independently
 * executed the nondet block (in this case, `gl.eq_principle.prompt_comparative`
 * over a live web fetch + LLM fact-extraction) and did NOT reach
 * equivalence. When that happens, no state change is actually applied —
 * confirmed by re-reading the claim afterward: it was still in its
 * pre-call status with no resolution recorded — even though the
 * transaction is marked FINALIZED and every per-validator result decodes
 * as "fine" in isolation. The only reliable signal for this is the vote
 * tally itself, which is why this checks `consensus_data.votes` first,
 * before trusting any individual result's byte tag.
 */
function findVoteOutcome(tx: unknown): VoteOutcome {
  const votes = (tx as { consensus_data?: { votes?: Record<string, string> } })?.consensus_data?.votes ?? {};
  const tally = Object.values(votes).reduce(
    (acc, v) => {
      if (v === "agree") acc.agree++;
      else if (v === "disagree") acc.disagree++;
      return acc;
    },
    { agree: 0, disagree: 0 },
  );
  if (tally.disagree > 0 && tally.disagree >= tally.agree) {
    return {
      ok: false,
      message:
        "Validators could not reach consensus on this call (majority disagreed) — no state change was applied. This can happen when a live web fetch or its LLM analysis produces different results across validators; try again, or with a more stable evidence source.",
    };
  }

  const validators = (tx as { consensus_data?: { validators?: ConsensusVote[] } })?.consensus_data?.validators ?? [];
  for (const v of validators) {
    const outcome = decodeVoteResult(v.result);
    if (outcome.ok !== null) return outcome; // skip idle votes only
  }
  return { ok: true };
}

/**
 * Every write requires the CALLER to pass the already-connected wallet
 * address explicitly — sourced from `useWallet()` (lib/wallet-context.tsx)
 * in whichever component initiates the write. This used to call
 * `connectWallet()` internally instead, which silently re-ran
 * `eth_requestAccounts` on every write rather than using whatever the user
 * had already connected via the sidebar/header button — the two flows
 * could disagree, which is what "pages didn't pick up the connected
 * wallet" actually was for the write side. Now there is exactly one source
 * of truth for "who is connected": the WalletProvider context.
 */
async function writeAndTrack(
  account: `0x${string}`,
  functionName: string,
  args: CalldataEncodable[],
  onStatus: (status: TxStatus) => void,
  options?: { value?: bigint },
): Promise<{ txHash: string }> {
  onStatus("preparing");
  const { address } = getContractConfig();

  const client = await getWalletClient(account);

  onStatus("wallet_prompt");
  let txHash: Awaited<ReturnType<typeof client.writeContract>>;
  try {
    txHash = await client.writeContract({
      address,
      functionName,
      args,
      value: options?.value ?? 0n,
    });
  } catch (err) {
    onStatus("rejected");
    throw err;
  }

  onStatus("submitted");

  try {
    const receipt = await Promise.race([
      client.waitForTransactionReceipt({
        hash: txHash,
        status: TransactionStatus.FINALIZED,
        retries: 40,
        interval: 3000,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timed_out")), TX_WAIT_TIMEOUT_MS),
      ),
    ]);

    const statusName = (receipt as unknown as { status_name?: string }).status_name;
    const finalStatus = mapStatusName(statusName);

    if (finalStatus !== "success" && finalStatus !== "confirmed") {
      onStatus(finalStatus);
      throw new Error(`Transaction did not succeed: ${statusName ?? "unknown status"}`);
    }

    // The receipt alone can't tell us whether the CONTRACT itself raised
    // (gl.vm.UserError) — consensus can finalize on "the leader's call
    // rolled back" just as cleanly as on a normal return. Fetch the full
    // transaction and check the validators' actual execution result.
    const tx = await client.getTransaction({ hash: txHash });
    const outcome = findVoteOutcome(tx);
    if (!outcome.ok) {
      onStatus("failed");
      throw new Error(outcome.message || "Transaction was rejected by the contract");
    }

    onStatus(finalStatus);

    // NOTE: a write's return value (e.g. the new claim id from
    // create_claim) isn't cleanly exposed here either — call sites that
    // need it re-derive it with a follow-up read instead (see
    // app/claims/new/page.tsx, which re-derives the new claim id from
    // get_claim_count() since ids are sequential).
    return { txHash };
  } catch (err) {
    if (err instanceof Error && err.message === "timed_out") {
      onStatus("timed_out");
    }
    throw err;
  }
}

async function read<T = unknown>(functionName: string, args: CalldataEncodable[] = []): Promise<T> {
  const { address } = getContractConfig();
  const client = getReadClient();
  const result = await client.readContract({
    address,
    functionName,
    args,
  });
  return result as T;
}

async function readJson<T>(functionName: string, args: CalldataEncodable[] = []): Promise<T> {
  const raw = await read<string>(functionName, args);
  return JSON.parse(raw) as T;
}

// ---------------------------------------------------------------------------
// READS — one wrapper per @gl.public.view method
// ---------------------------------------------------------------------------

export const contractReads = {
  listProtocols: () => readJson<Record<string, string>>("list_protocols"),
  getSeason: (seasonId: string) => readJson<unknown>("get_season", [seasonId]),
  getOwner: () => read<string>("get_owner"),
  getEvidence: (evidenceId: string) => readJson<unknown>("get_evidence", [evidenceId]),
  listEvidenceForClaim: (claimId: string) => readJson<unknown[]>("list_evidence_for_claim", [claimId]),
  getObjection: (objectionId: string) => readJson<unknown>("get_objection", [objectionId]),
  listObjectionsForClaim: (claimId: string) => readJson<unknown[]>("list_objections_for_claim", [claimId]),
  getChallenge: (claimId: string) => readJson<unknown>("get_challenge", [claimId]),
  getBounty: (claimId: string) => readJson<unknown>("get_bounty", [claimId]),
  getReputationEventsForUser: (user: string) => readJson<unknown[]>("get_reputation_events_for_user", [user]),
  getReputationEventCount: () => read<number>("get_reputation_event_count"),
  getClaim: (claimId: string) => readJson<unknown>("get_claim", [claimId]),
  getClaimVersion: (claimId: string, version: number) =>
    readJson<unknown>("get_claim_version", [claimId, version]),
  listClaimVersions: (claimId: string) => readJson<unknown[]>("list_claim_versions", [claimId]),
  getResolution: (claimId: string) => readJson<unknown>("get_resolution", [claimId]),
  getHumanSettlementProposals: (claimId: string) =>
    readJson<Record<string, number>>("get_human_settlement_proposals", [claimId]),
  listOpenClaimIds: () => readJson<string[]>("list_open_claim_ids"),
  listClaimsByStatus: (status: string) => readJson<unknown[]>("list_claims_by_status", [status]),
  getClaimCount: () => read<number>("get_claim_count"),
  getAppeal: (claimId: string) => readJson<unknown>("get_appeal", [claimId]),
};

// ---------------------------------------------------------------------------
// WRITES — one wrapper per @gl.public.write / .payable method
// ---------------------------------------------------------------------------

type Account = `0x${string}`;

export const contractWrites = {
  transferOwnership: (account: Account, newOwner: string, onStatus: (s: TxStatus) => void) =>
    writeAndTrack(account, "transfer_ownership", [newOwner], onStatus),

  registerProtocol: (account: Account, name: string, category: string, onStatus: (s: TxStatus) => void) =>
    writeAndTrack(account, "register_protocol", [name, category], onStatus),

  createSeason: (
    account: Account,
    name: string,
    startsAtIso: string,
    endsAtIso: string,
    onStatus: (s: TxStatus) => void,
  ) => writeAndTrack(account, "create_season", [name, startsAtIso, endsAtIso], onStatus),

  createClaim: (
    account: Account,
    params: {
      protocol: string;
      category: string;
      subject: string;
      sourceStatement: string;
      interpretation: string;
      difficulty: "EASY" | "AMBIGUOUS" | "HARD" | "EXTREME";
      challengeWindowSeconds: number;
      bondGen: string;
    },
    onStatus: (s: TxStatus) => void,
  ) =>
    writeAndTrack(
      account,
      "create_claim",
      [
        params.protocol,
        params.category,
        params.subject,
        params.sourceStatement,
        params.interpretation,
        params.difficulty,
        params.challengeWindowSeconds,
      ],
      onStatus,
      { value: parseGen(params.bondGen) },
    ),

  amendClaim: (
    account: Account,
    claimId: string,
    newInterpretation: string,
    rationale: string,
    onStatus: (s: TxStatus) => void,
  ) => writeAndTrack(account, "amend_claim", [claimId, newInterpretation, rationale], onStatus),

  withdrawClaim: (account: Account, claimId: string, onStatus: (s: TxStatus) => void) =>
    writeAndTrack(account, "withdraw_claim", [claimId], onStatus),

  claimExpired: (account: Account, claimId: string, onStatus: (s: TxStatus) => void) =>
    writeAndTrack(account, "claim_expired", [claimId], onStatus),

  submitEvidence: (
    account: Account,
    params: {
      claimId: string;
      evidenceType: string;
      url: string;
      description: string;
      side: "SUPPORT" | "CHALLENGE" | "NEUTRAL";
    },
    onStatus: (s: TxStatus) => void,
  ) =>
    writeAndTrack(
      account,
      "submit_evidence",
      [params.claimId, params.evidenceType, params.url, params.description, params.side],
      onStatus,
    ),

  raiseObjection: (account: Account, claimId: string, text: string, onStatus: (s: TxStatus) => void) =>
    writeAndTrack(account, "raise_objection", [claimId, text], onStatus),

  respondToObjection: (
    account: Account,
    objectionId: string,
    responseText: string,
    onStatus: (s: TxStatus) => void,
  ) => writeAndTrack(account, "respond_to_objection", [objectionId, responseText], onStatus),

  submitChallenge: (
    account: Account,
    claimId: string,
    argument: string,
    stakeGen: string,
    onStatus: (s: TxStatus) => void,
  ) =>
    writeAndTrack(account, "submit_challenge", [claimId, argument], onStatus, {
      value: parseGen(stakeGen),
    }),

  createBounty: (
    account: Account,
    params: {
      claimId: string;
      challengerBps: number;
      evidenceBps: number;
      interpreterBps: number;
      totalGen: string;
    },
    onStatus: (s: TxStatus) => void,
  ) =>
    writeAndTrack(
      account,
      "create_bounty",
      [params.claimId, params.challengerBps, params.evidenceBps, params.interpreterBps],
      onStatus,
      { value: parseGen(params.totalGen) },
    ),

  contributeToBounty: (account: Account, claimId: string, amountGen: string, onStatus: (s: TxStatus) => void) =>
    writeAndTrack(account, "contribute_to_bounty", [claimId], onStatus, { value: parseGen(amountGen) }),

  submitForJudgment: (account: Account, claimId: string, onStatus: (s: TxStatus) => void) =>
    writeAndTrack(account, "submit_for_judgment", [claimId], onStatus),

  proposeHumanSettlement: (
    account: Account,
    claimId: string,
    claimantPayoutBps: number,
    onStatus: (s: TxStatus) => void,
  ) => writeAndTrack(account, "propose_human_settlement", [claimId, claimantPayoutBps], onStatus),

  claimDisputeTimeout: (account: Account, claimId: string, onStatus: (s: TxStatus) => void) =>
    writeAndTrack(account, "claim_dispute_timeout", [claimId], onStatus),

  // v0.3.6: appeal bond is a fixed 10 GEN (APPEAL_BOND_WEI == MIN_CLAIM_BOND_WEI
  // in contract.py) — not user-configurable, so it's hardcoded here rather
  // than taking a param a caller could get wrong and have rejected on-chain.
  raiseAppeal: (account: Account, claimId: string, onStatus: (s: TxStatus) => void) =>
    writeAndTrack(account, "raise_appeal", [claimId], onStatus, { value: parseGen("10") }),

  finalizeSettlement: (account: Account, claimId: string, onStatus: (s: TxStatus) => void) =>
    writeAndTrack(account, "finalize_settlement", [claimId], onStatus),
};
