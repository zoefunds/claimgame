export type TxStatus =
  | "idle"
  | "preparing"
  | "wallet_prompt"
  | "submitted"
  | "pending"
  | "confirmed"
  | "success"
  | "rejected"
  | "failed"
  | "timed_out"
  | "unknown";

export type ClaimStatus =
  | "OPEN"
  | "CHALLENGED"
  | "UNDER_REVIEW"
  | "PENDING_APPEAL"
  | "RESOLVED_MERGE"
  | "RESOLVED_REJECT"
  | "RESOLVED_PARTIAL"
  | "NEEDS_HUMAN_REVIEW"
  | "RESOLVED_DISPUTE_TIMEOUT"
  | "EXPIRED"
  | "WITHDRAWN";

export type Difficulty = "EASY" | "AMBIGUOUS" | "HARD" | "EXTREME";

export interface Claim {
  id: string;
  protocol: string;
  category: string;
  subject: string;
  source_statement: string;
  creator: string;
  status: ClaimStatus;
  difficulty: Difficulty;
  claim_bond_wei: string;
  claim_bond_deposited: string;
  created_at: string;
  challenge_window_seconds: number;
  current_version: number;
  season_id: string;
  review_deadline?: string;
  resolved_at?: string;
  /** Populated only while status === "PENDING_APPEAL" (v0.3.6). */
  pending_verdict?: "PASSED" | "FAILED" | "PARTIAL";
  pending_payout_bps?: number;
  appeal_deadline?: string;
}

export interface Appeal {
  claim_id: string;
  appellant: string;
  appeal_bond_wei: string;
  original_verdict: string;
  original_payout_bps: number;
  appeal_verdict: string;
  appeal_payout_bps: number;
  outcome: "UPHELD_ORIGINAL" | "OVERTURNED" | "INCONCLUSIVE_APPEAL_ORIGINAL_STANDS";
  resolved_at: string;
}

export interface ClaimVersion {
  claim_id: string;
  version: number;
  interpretation: string;
  author: string;
  rationale: string;
  created_at: string;
}

export interface Evidence {
  id: string;
  claim_id: string;
  submitter: string;
  evidence_type: string;
  url: string;
  description: string;
  side: "SUPPORT" | "CHALLENGE" | "NEUTRAL";
  submitted_at: string;
  cited_in_verdict: boolean;
  /** Evidence Manifest fields (audit remediation v0.3.0) — null until the
   * judgment step actually fetches this source. */
  retrieved_at?: string | null;
  content_hash?: string | null;
  /** v0.3.6 — the actual excerpt text, preserved verbatim, not just hashed. */
  snapshot_text?: string | null;
  /** v0.3.7 — SHA-256 of the full normalized page, for verifying the
   * original source against this fingerprint even though only the
   * excerpt above is stored verbatim. */
  full_page_hash?: string | null;
  /** v0.3.8 — off-chain archive of the raw page, fetched independently by
   * our own indexer (not the contract) and verified against full_page_hash. */
  archived_at?: string | null;
  archive_hash_matches?: boolean | null;
  /** v0.3.9 — a real CIDv1 (raw codec, sha2-256) over the archived content.
   * Not yet pinned to a live IPFS/Arweave network, but a genuine, correct
   * content identifier ready for pinning whenever that credential exists. */
  archive_cid?: string | null;
}

export interface Challenge {
  claim_id: string;
  challenger: string;
  challenge_stake_wei: string;
  challenge_stake_deposited: string;
  argument: string;
  created_at: string;
  status: "ACTIVE" | "SETTLED";
}

export interface Resolution {
  claim_id: string;
  verdict: "PASSED" | "FAILED" | "PARTIAL" | "INCONCLUSIVE";
  confidence: "HIGH" | "MEDIUM" | "LOW";
  payout_bps: number;
  reasoning_summary: string;
  evidence_cited: string[];
  resolved_at: string;
}

// ---------------------------------------------------------------------------
// Backend cache shapes (apps/api Prisma models, camelCase over REST) and
// mappers into the snake_case shapes above — those match the contract's own
// JSON field names 1:1 (see contracts/claimgame/contract.py) since most UI
// still reads directly from the contract for writes/live views. Keeping one
// mapping layer here means every component only ever deals with one shape
// regardless of whether a given page's data came from the contract or the
// backend cache.
// ---------------------------------------------------------------------------

export interface BackendClaim {
  id: string;
  protocol: string;
  category: string;
  subject: string;
  sourceStatement: string;
  creator: string;
  status: ClaimStatus;
  difficulty: Difficulty;
  claimBondWei: string;
  claimBondDeposited: string;
  currentVersion: number;
  challengeWindowSeconds: number;
  seasonId: string | null;
  createdAt: string;
  resolvedAt: string | null;
  pendingVerdict?: "PASSED" | "FAILED" | "PARTIAL" | null;
  pendingPayoutBps?: number | null;
  appealDeadline?: string | null;
  versions?: BackendClaimVersion[];
  evidence?: BackendEvidence[];
  challenge?: BackendChallenge | null;
  resolution?: BackendResolution | null;
  appeal?: BackendAppeal | null;
}

export interface BackendAppeal {
  claimId: string;
  appellant: string;
  appealBondWei: string;
  originalVerdict: string;
  originalPayoutBps: number;
  appealVerdict: string;
  appealPayoutBps: number;
  outcome: "UPHELD_ORIGINAL" | "OVERTURNED" | "INCONCLUSIVE_APPEAL_ORIGINAL_STANDS";
  resolvedAt: string;
}

export interface BackendClaimVersion {
  claimId: string;
  version: number;
  interpretation: string;
  author: string;
  rationale: string | null;
  createdAt: string;
}

export interface BackendEvidence {
  id: string;
  claimId: string;
  submitter: string;
  evidenceType: string;
  url: string | null;
  description: string;
  side: "SUPPORT" | "CHALLENGE" | "NEUTRAL";
  citedInVerdict: boolean;
  submittedAt: string;
  retrievedAt?: string | null;
  contentHash?: string | null;
  snapshotText?: string | null;
  fullPageHash?: string | null;
  archivedAt?: string | null;
  archiveHashMatches?: boolean | null;
  archiveCid?: string | null;
}

export interface BackendChallenge {
  claimId: string;
  challenger: string;
  challengeStakeWei: string;
  challengeStakeDeposited: string;
  argument: string;
  status: "ACTIVE" | "SETTLED";
  createdAt: string;
}

export interface BackendResolution {
  claimId: string;
  verdict: "PASSED" | "FAILED" | "PARTIAL" | "INCONCLUSIVE";
  confidence: "HIGH" | "MEDIUM" | "LOW";
  payoutBps: number;
  reasoningSummary: string;
  evidenceCited: string[];
  resolvedAt: string;
}

export function mapBackendClaim(row: BackendClaim): Claim {
  return {
    id: row.id,
    protocol: row.protocol,
    category: row.category,
    subject: row.subject,
    source_statement: row.sourceStatement,
    creator: row.creator,
    status: row.status,
    difficulty: row.difficulty,
    claim_bond_wei: row.claimBondWei,
    claim_bond_deposited: row.claimBondDeposited,
    created_at: row.createdAt,
    challenge_window_seconds: row.challengeWindowSeconds,
    current_version: row.currentVersion,
    season_id: row.seasonId ?? "",
    resolved_at: row.resolvedAt ?? undefined,
    pending_verdict: row.pendingVerdict ?? undefined,
    pending_payout_bps: row.pendingPayoutBps ?? undefined,
    appeal_deadline: row.appealDeadline ?? undefined,
  };
}

export function mapBackendClaimVersion(row: BackendClaimVersion): ClaimVersion {
  return {
    claim_id: row.claimId,
    version: row.version,
    interpretation: row.interpretation,
    author: row.author,
    rationale: row.rationale ?? "",
    created_at: row.createdAt,
  };
}

export function mapBackendEvidence(row: BackendEvidence): Evidence {
  return {
    id: row.id,
    claim_id: row.claimId,
    submitter: row.submitter,
    evidence_type: row.evidenceType,
    url: row.url ?? "",
    description: row.description,
    side: row.side,
    submitted_at: row.submittedAt,
    cited_in_verdict: row.citedInVerdict,
    retrieved_at: row.retrievedAt,
    content_hash: row.contentHash,
    snapshot_text: row.snapshotText,
    full_page_hash: row.fullPageHash,
    archived_at: row.archivedAt,
    archive_hash_matches: row.archiveHashMatches,
    archive_cid: row.archiveCid,
  };
}

export function mapBackendChallenge(row: BackendChallenge): Challenge {
  return {
    claim_id: row.claimId,
    challenger: row.challenger,
    challenge_stake_wei: row.challengeStakeWei,
    challenge_stake_deposited: row.challengeStakeDeposited,
    argument: row.argument,
    created_at: row.createdAt,
    status: row.status,
  };
}

export function mapBackendResolution(row: BackendResolution): Resolution {
  return {
    claim_id: row.claimId,
    verdict: row.verdict,
    confidence: row.confidence,
    payout_bps: row.payoutBps,
    reasoning_summary: row.reasoningSummary,
    evidence_cited: row.evidenceCited,
    resolved_at: row.resolvedAt,
  };
}

export function mapBackendAppeal(row: BackendAppeal): Appeal {
  return {
    claim_id: row.claimId,
    appellant: row.appellant,
    appeal_bond_wei: row.appealBondWei,
    original_verdict: row.originalVerdict,
    original_payout_bps: row.originalPayoutBps,
    appeal_verdict: row.appealVerdict,
    appeal_payout_bps: row.appealPayoutBps,
    outcome: row.outcome,
    resolved_at: row.resolvedAt,
  };
}
