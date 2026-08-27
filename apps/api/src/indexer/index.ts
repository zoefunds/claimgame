/**
 * CLAIMGAME indexer worker
 * =========================
 *
 * Mirrors the deployed GenLayer contract's state into Postgres CACHE tables
 * (see docs/architecture.md §2, §15 and prisma/schema.prisma). This process
 * is the ONLY writer for `claims`, `claim_versions`, `evidence`,
 * `challenges`, `objections`, `resolutions`, `reputation_events`,
 * `reputation_scores`, and `leaderboard_entries` — no API route ever writes
 * to these tables directly, which is what guarantees the backend can never
 * silently disagree with the contract.
 *
 * Uses `genlayer-js`'s read-only client (confirmed against the installed
 * genlayer-js@1.1.8 package: `createClient({ chain: studionet })` +
 * `client.readContract(...)`, no account/signing needed for reads). The
 * contract has no "list all claims since block N" event feed, so this
 * polls the same way a full re-sync would: `list_open_claim_ids` (despite
 * the name, this array is append-only and every claim id ever created stays
 * in it — see contracts/claimgame/contract.py's `create_claim`, which never
 * removes an id regardless of later status) enumerates every claim, then
 * each claim's full state is re-fetched. This is O(claims), not O(new
 * events) — fine at CLAIMGAME's expected claim volume, and simpler than a
 * synthetic block-range cursor the contract doesn't actually expose. The
 * `IndexerCursor` row still records `updatedAt` so `/healthz`-style checks
 * can detect a stalled indexer.
 */

import { PrismaClient, type Prisma } from "@prisma/client";
import { createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { getEnv } from "../env.js";

/**
 * PRODUCTION INCIDENT (confirmed live, 2026-08-26): StudioNet's RPC rate
 * limit is 500 requests/hour. This worker's original 5s full-rescan design
 * (get_claim + list_claim_versions + list_evidence_for_claim +
 * list_objections_for_claim + get_challenge + get_resolution + reputation
 * lookups, PER CLAIM, EVERY TICK) burned through that budget within
 * minutes once there were more than a handful of claims — the indexer
 * logged "Rate limit exceeded: 500 requests per hour" on every subsequent
 * tick and silently stopped syncing new claims. Two fixes, both required:
 *  1. A much longer interval (below).
 *  2. Change-detection in `tick()`: a claim already in a TERMINAL status
 *     that matches what's cached in Postgres is fully skipped — nothing
 *     about it can change again, so re-fetching its versions/evidence/
 *     objections/challenge/resolution/reputation every tick forever was
 *     pure waste. Only claims that are new or still active pay the full
 *     per-claim RPC cost. This is also why "poll every 5s" was never going
 *     to scale regardless of the interval — it's now closer to O(active
 *     claims) than O(all claims ever created).
 */
const POLL_INTERVAL_MS = 15 * 60_000; // 15 minutes — see rate-limit note above

// See the capacity-warning comment in tick() — conservative estimate of how
// many ACTIVE (non-terminal, fully-synced) claims one tick can safely carry
// without risking the 500/hour budget across ~4 ticks/hour at this interval.
const ACTIVE_CLAIM_CAPACITY_WARNING = 12;

const TERMINAL_STATUSES = new Set([
  "RESOLVED_MERGE",
  "RESOLVED_REJECT",
  "RESOLVED_PARTIAL",
  "RESOLVED_DISPUTE_TIMEOUT",
  "EXPIRED",
  "WITHDRAWN",
]);

const prisma = new PrismaClient();

/**
 * SECOND rate limit discovered live (2026-08-26, same incident): StudioNet
 * also caps at 30 requests/MINUTE, independent of the 500/hour budget. The
 * 15-minute tick interval above keeps the hourly budget safe, but a single
 * tick still fires every claim's ~6-8 calls back-to-back with zero spacing
 * — for more than 3-4 active claims that burst alone exceeds 30/min and
 * the whole tick throws immediately (via viem's retry-exhausted error),
 * silently abandoning every claim after whichever one tripped the limit.
 * That's why claim #5 (evidence-bearing, needed a full sync) went unsynced
 * while claims #1-4 (all empty, but processed earlier in id order) made it
 * through. Every `client.readContract` call in this file must go through
 * `throttledReadContract` instead of being called directly, which spaces
 * calls out to stay under the per-minute cap with margin.
 */
const MIN_CALL_SPACING_MS = 2_200; // ~27 calls/min, safely under the 30/min cap
let lastCallAt = 0;
let rateLimitQueue: Promise<void> = Promise.resolve();

async function throttledReadContract(
  client: ReturnType<typeof createClient>,
  params: Parameters<ReturnType<typeof createClient>["readContract"]>[0],
): Promise<unknown> {
  const myTurn = rateLimitQueue.then(async () => {
    const wait = Math.max(0, lastCallAt + MIN_CALL_SPACING_MS - Date.now());
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastCallAt = Date.now();
  });
  rateLimitQueue = myTurn;
  await myTurn;
  return client.readContract(params);
}

function readJson<T>(raw: unknown): T {
  return JSON.parse(raw as string) as T;
}

/** GenLayer/EVM addresses can come back checksummed (mixed case) from the
 * contract; every address column in Postgres is queried case-insensitively
 * from the frontend (`.toLowerCase()` in routes/claims.ts and
 * routes/profile.ts), so every address MUST be lowercased at write time
 * here too, or a wallet's own claims silently fail to match its own
 * lowercase-normalized query filters. Only used for Postgres storage —
 * contract calls still use the original-case address. */
function lc(address: string): string {
  return address.toLowerCase();
}

type ChainClaim = {
  id: string;
  protocol: string;
  category: string;
  subject: string;
  source_statement: string;
  creator: string;
  status: string;
  difficulty: string;
  claim_bond_wei: string;
  claim_bond_deposited: string;
  created_at: string;
  challenge_window_seconds: number;
  current_version: number;
  season_id: string;
  resolved_at?: string;
  pending_verdict?: string;
  pending_payout_bps?: number;
  appeal_deadline?: string;
};

async function fetchClaim(client: ReturnType<typeof createClient>, address: `0x${string}`, claimId: string): Promise<ChainClaim> {
  const claimRaw = await throttledReadContract(client, { address, functionName: "get_claim", args: [claimId] });
  return readJson<ChainClaim>(claimRaw);
}

async function upsertClaim(claim: ChainClaim): Promise<void> {
  await prisma.claim.upsert({
    where: { id: claim.id },
    create: {
      id: claim.id,
      protocol: claim.protocol,
      category: claim.category,
      subject: claim.subject,
      sourceStatement: claim.source_statement,
      creator: lc(claim.creator),
      status: claim.status,
      difficulty: claim.difficulty,
      claimBondWei: claim.claim_bond_wei,
      claimBondDeposited: claim.claim_bond_deposited,
      currentVersion: claim.current_version,
      challengeWindowSeconds: claim.challenge_window_seconds,
      seasonId: claim.season_id || null,
      createdAt: new Date(claim.created_at),
      resolvedAt: claim.resolved_at ? new Date(claim.resolved_at) : null,
      pendingVerdict: claim.pending_verdict ?? null,
      pendingPayoutBps: claim.pending_payout_bps ?? null,
      appealDeadline: claim.appeal_deadline ? new Date(claim.appeal_deadline) : null,
      contractTxHash: "", // GenLayer reads don't expose the originating tx hash per-field; left blank rather than fabricated.
    },
    update: {
      status: claim.status,
      claimBondDeposited: claim.claim_bond_deposited,
      currentVersion: claim.current_version,
      resolvedAt: claim.resolved_at ? new Date(claim.resolved_at) : null,
      pendingVerdict: claim.pending_verdict ?? null,
      pendingPayoutBps: claim.pending_payout_bps ?? null,
      appealDeadline: claim.appeal_deadline ? new Date(claim.appeal_deadline) : null,
    },
  });
}

async function syncVersions(client: ReturnType<typeof createClient>, address: `0x${string}`, claimId: string): Promise<void> {
  const raw = await throttledReadContract(client, { address, functionName: "list_claim_versions", args: [claimId] });
  const versions = readJson<{ claim_id: string; version: number; interpretation: string; author: string; rationale: string; created_at: string }[]>(raw);
  for (const v of versions) {
    await prisma.claimVersion.upsert({
      where: { claimId_version: { claimId, version: v.version } },
      create: {
        claimId,
        version: v.version,
        interpretation: v.interpretation,
        author: lc(v.author),
        rationale: v.rationale,
        createdAt: new Date(v.created_at),
      },
      update: { interpretation: v.interpretation },
    });
  }
}

async function syncEvidence(client: ReturnType<typeof createClient>, address: `0x${string}`, claimId: string): Promise<void> {
  const raw = await throttledReadContract(client, { address, functionName: "list_evidence_for_claim", args: [claimId] });
  const items = readJson<
    {
      id: string;
      claim_id: string;
      submitter: string;
      evidence_type: string;
      url: string;
      description: string;
      side: string;
      submitted_at: string;
      cited_in_verdict: boolean;
      retrieved_at: string | null;
      content_hash: string | null;
      snapshot_text: string | null;
    }[]
  >(raw);
  for (const item of items) {
    await prisma.evidence.upsert({
      where: { id: item.id },
      create: {
        id: item.id,
        claimId,
        submitter: lc(item.submitter),
        evidenceType: item.evidence_type,
        url: item.url || null,
        description: item.description,
        side: item.side,
        citedInVerdict: item.cited_in_verdict,
        submittedAt: new Date(item.submitted_at),
        contractTxHash: "",
        retrievedAt: item.retrieved_at ? new Date(item.retrieved_at) : null,
        contentHash: item.content_hash,
        snapshotText: item.snapshot_text,
      },
      update: {
        citedInVerdict: item.cited_in_verdict,
        retrievedAt: item.retrieved_at ? new Date(item.retrieved_at) : null,
        contentHash: item.content_hash,
        snapshotText: item.snapshot_text,
      },
    });
  }
}

/** Audit finding #10 (partial): objections were never synced at all — the
 * schema and the `GET /api/v1/claims/:id` route both already expected an
 * `objections` relation, but nothing ever populated it, so the API
 * silently returned an empty array forever regardless of what was on
 * chain. */
async function syncObjections(client: ReturnType<typeof createClient>, address: `0x${string}`, claimId: string): Promise<void> {
  const raw = await throttledReadContract(client, { address, functionName: "list_objections_for_claim", args: [claimId] });
  const items = readJson<
    { id: string; claim_id: string; author: string; text: string; response: string; created_at: string; resolved: boolean }[]
  >(raw);
  for (const item of items) {
    await prisma.objection.upsert({
      where: { id: item.id },
      create: {
        id: item.id,
        claimId,
        author: lc(item.author),
        text: item.text,
        response: item.response || null,
        resolved: item.resolved,
        createdAt: new Date(item.created_at),
      },
      update: { response: item.response || null, resolved: item.resolved },
    });
  }
}

async function syncChallenge(client: ReturnType<typeof createClient>, address: `0x${string}`, claimId: string): Promise<void> {
  try {
    const raw = await throttledReadContract(client, { address, functionName: "get_challenge", args: [claimId] });
    const challenge = readJson<{
      claim_id: string;
      challenger: string;
      challenge_stake_wei: string;
      challenge_stake_deposited: string;
      argument: string;
      created_at: string;
      status: string;
    }>(raw);

    await prisma.challenge.upsert({
      where: { claimId },
      create: {
        claimId,
        challenger: lc(challenge.challenger),
        challengeStakeWei: challenge.challenge_stake_wei,
        challengeStakeDeposited: challenge.challenge_stake_deposited,
        argument: challenge.argument,
        status: challenge.status,
        createdAt: new Date(challenge.created_at),
        contractTxHash: "",
      },
      update: {
        challengeStakeDeposited: challenge.challenge_stake_deposited,
        status: challenge.status,
      },
    });
  } catch {
    // No challenge exists for this claim yet — the contract raises
    // gl.vm.UserError("No challenge for this claim"), which surfaces here
    // as a rejected read. Nothing to sync.
  }
}

async function syncResolution(client: ReturnType<typeof createClient>, address: `0x${string}`, claimId: string): Promise<void> {
  try {
    const raw = await throttledReadContract(client, { address, functionName: "get_resolution", args: [claimId] });
    const resolution = readJson<{
      claim_id: string;
      verdict: string;
      confidence: string;
      payout_bps: number;
      reasoning_summary: string;
      evidence_cited: string[];
      resolved_at: string;
    }>(raw);

    await prisma.resolution.upsert({
      where: { claimId },
      create: {
        claimId,
        verdict: resolution.verdict,
        confidence: resolution.confidence,
        payoutBps: resolution.payout_bps,
        reasoningSummary: resolution.reasoning_summary,
        evidenceCited: resolution.evidence_cited as unknown as Prisma.InputJsonValue,
        resolvedAt: new Date(resolution.resolved_at),
        contractTxHash: "",
      },
      update: {
        verdict: resolution.verdict,
        confidence: resolution.confidence,
        payoutBps: resolution.payout_bps,
      },
    });
  } catch {
    // No resolution recorded yet — nothing to sync.
  }
}

/** v0.3.6 — syncs the appeal record if one was raised for this claim (at
 * most one per claim, mirroring the contract's `appeals` TreeMap). */
async function syncAppeal(client: ReturnType<typeof createClient>, address: `0x${string}`, claimId: string): Promise<void> {
  try {
    const raw = await throttledReadContract(client, { address, functionName: "get_appeal", args: [claimId] });
    if (raw === "null" || !raw) return;
    const appeal = readJson<{
      claim_id: string;
      appellant: string;
      appeal_bond: string;
      original_verdict: string;
      original_payout_bps: number;
      appeal_verdict: string;
      appeal_payout_bps: number;
      outcome: string;
      resolved_at: string;
    }>(raw);

    await prisma.appeal.upsert({
      where: { claimId },
      create: {
        claimId,
        appellant: lc(appeal.appellant),
        appealBondWei: appeal.appeal_bond,
        originalVerdict: appeal.original_verdict,
        originalPayoutBps: appeal.original_payout_bps,
        appealVerdict: appeal.appeal_verdict,
        appealPayoutBps: appeal.appeal_payout_bps,
        outcome: appeal.outcome,
        resolvedAt: new Date(appeal.resolved_at),
        contractTxHash: "",
      },
      update: {
        outcome: appeal.outcome,
      },
    });
  } catch {
    // No appeal raised for this claim — nothing to sync.
  }
}

/**
 * Recomputes reputation_scores from reputation_events, mirroring
 * contract.py's `get_reputation_events_for_user` fan-out but done once
 * across all users here instead of per-user on-chain calls.
 *
 * Takes the already-fetched `claim` (from `tick()`'s single `get_claim`
 * call for this claim id) rather than re-fetching it — every RPC call here
 * counts against StudioNet's 500-requests/hour limit (see the POLL_INTERVAL_MS
 * comment). Still does its own `get_challenge` call since `tick()` doesn't
 * fetch that separately for active claims.
 *
 * Deliberately uses the ORIGINAL-CASE creator/challenger, not a
 * Postgres-lowercased value: the CONTRACT's own
 * `get_reputation_events_for_user` does an exact string match against the
 * checksummed address it stored via `str(gl.message.sender_address)` —
 * passing it a lowercased address would silently return zero events.
 * Original case in, lowercase out (see `lc()`).
 */
async function recomputeReputationForClaim(client: ReturnType<typeof createClient>, address: `0x${string}`, claimId: string, claim: ChainClaim): Promise<void> {
  const wallets = new Set<string>([claim.creator]);
  try {
    const challengeRaw = await throttledReadContract(client, { address, functionName: "get_challenge", args: [claimId] });
    const challenge = readJson<{ challenger: string }>(challengeRaw);
    wallets.add(challenge.challenger);
  } catch {
    // No challenge yet — nothing to add.
  }

  for (const wallet of wallets) {
    const raw = await throttledReadContract(client, { address, functionName: "get_reputation_events_for_user", args: [wallet] });
    const events = readJson<{ claim_id: string; role: string; outcome: string; stake_weight: string; at: string }[]>(raw);
    const walletLc = lc(wallet);

    await prisma.reputationEvent.deleteMany({ where: { user: walletLc } });
    if (events.length > 0) {
      await prisma.reputationEvent.createMany({
        data: events.map((e) => ({
          user: walletLc,
          claimId: e.claim_id,
          role: e.role,
          outcome: e.outcome,
          stakeWeight: e.stake_weight,
          occurredAt: new Date(e.at),
        })),
      });
    }

    const claimantEvents = events.filter((e) => e.role === "CLAIMANT");
    const challengerEvents = events.filter((e) => e.role === "CHALLENGER");
    const evidenceEvents = events.filter((e) => e.role === "EVIDENCE");

    const accuracy = (rows: typeof events) =>
      rows.length === 0 ? 0 : rows.filter((r) => r.outcome === "WON" || r.outcome === "PARTIAL").length / rows.length;

    await prisma.reputationScore.upsert({
      where: { walletAddress: walletLc },
      create: {
        walletAddress: walletLc,
        interpretationAccuracy: accuracy(claimantEvents),
        challengeAccuracy: accuracy(challengerEvents),
        evidenceReliability: 0,
        claimsCreated: claimantEvents.filter((e) => e.outcome === "CREATED").length,
        challengesRaised: challengerEvents.length,
        evidenceSubmitted: evidenceEvents.length,
      },
      update: {
        interpretationAccuracy: accuracy(claimantEvents),
        challengeAccuracy: accuracy(challengerEvents),
        claimsCreated: claimantEvents.filter((e) => e.outcome === "CREATED").length,
        challengesRaised: challengerEvents.length,
        evidenceSubmitted: evidenceEvents.length,
      },
    });
  }
}

const CURRENT_SEASON_ID = "1"; // no on-chain season selection yet (contract.py's seasons registry is admin-managed metadata only) — matches apps/web's CURRENT_SEASON constant.

const LEADERBOARD_CATEGORIES: {
  key: string;
  scoreField: "interpretationAccuracy" | "challengeAccuracy" | "evidenceSubmitted";
}[] = [
  { key: "INTERPRETER", scoreField: "interpretationAccuracy" },
  { key: "DETECTIVE", scoreField: "challengeAccuracy" },
  { key: "EVIDENCE_HUNTER", scoreField: "evidenceSubmitted" },
];

/** Ranks every wallet with a reputation_scores row into leaderboard_entries
 * per category. Without this, `/api/v1/leaderboard` always returns an
 * empty array — the table exists in the schema but nothing else writes to
 * it, so this was silently dead before, not just stale. */
async function recomputeLeaderboard(): Promise<void> {
  const scores = await prisma.reputationScore.findMany();

  for (const category of LEADERBOARD_CATEGORIES) {
    const ranked = [...scores]
      .filter((s) => Number(s[category.scoreField]) > 0)
      .sort((a, b) => Number(b[category.scoreField]) - Number(a[category.scoreField]))
      .slice(0, 50);

    for (let i = 0; i < ranked.length; i++) {
      const entry = ranked[i];
      await prisma.leaderboardEntry.upsert({
        where: {
          seasonId_category_walletAddress: {
            seasonId: CURRENT_SEASON_ID,
            category: category.key,
            walletAddress: entry.walletAddress,
          },
        },
        create: {
          seasonId: CURRENT_SEASON_ID,
          category: category.key,
          walletAddress: entry.walletAddress,
          rank: i + 1,
          scoreValue: Number(entry[category.scoreField]),
        },
        update: {
          rank: i + 1,
          scoreValue: Number(entry[category.scoreField]),
        },
      });
    }
  }
}

async function tick(client: ReturnType<typeof createClient>, address: `0x${string}`): Promise<void> {
  const idsRaw = await throttledReadContract(client, { address, functionName: "list_open_claim_ids", args: [] });
  const ids = readJson<string[]>(idsRaw);

  let skipped = 0;
  for (const id of ids) {
    const claim = await fetchClaim(client, address, id); // 1 call, always paid — needed to detect status changes

    const cached = await prisma.claim.findUnique({ where: { id }, select: { status: true } });
    const alreadySettled = !!cached && TERMINAL_STATUSES.has(cached.status) && cached.status === claim.status;
    if (alreadySettled) {
      skipped++;
      continue; // nothing about a settled, unchanged claim can ever change again
    }

    await upsertClaim(claim);
    await syncVersions(client, address, id);
    await syncEvidence(client, address, id);
    await syncObjections(client, address, id);
    await syncChallenge(client, address, id);
    await syncResolution(client, address, id);
    await syncAppeal(client, address, id);
    await recomputeReputationForClaim(client, address, id, claim);
  }

  await recomputeLeaderboard();

  await prisma.indexerCursor.upsert({
    where: { id: 1 },
    create: { id: 1, lastBlock: BigInt(ids.length) },
    update: { lastBlock: BigInt(ids.length) },
  });

  const activeCount = ids.length - skipped;
  // eslint-disable-next-line no-console
  console.log(`Indexer tick: ${ids.length} claims total, ${skipped} already-settled skipped, ${activeCount} fully synced.`);

  // Audit finding #6: this worker is capacity-bound by StudioNet's RPC
  // limits (500/hour, 30/minute — see the throttling comment above), not
  // by anything in our own control. ACTIVE_CLAIM_CAPACITY_WARNING is the
  // rough point past which a single 15-minute tick's RPC cost (active
  // claims × ~8 calls each, spaced 2.2s apart) starts eating into the
  // hourly budget across the ~4 ticks/hour this interval implies. This
  // doesn't fix the underlying capacity ceiling — that needs either a
  // genuinely event-driven sync (no polling) or a paid/higher-tier RPC
  // endpoint — but it makes the ceiling visible in logs instead of the
  // indexer silently falling behind the way it did during the original
  // rate-limit incident.
  if (activeCount > ACTIVE_CLAIM_CAPACITY_WARNING) {
    // eslint-disable-next-line no-console
    console.warn(
      `Indexer capacity warning: ${activeCount} active claims exceeds the safe per-tick budget ` +
        `(${ACTIVE_CLAIM_CAPACITY_WARNING}) for StudioNet's rate limits at a ${POLL_INTERVAL_MS / 60_000}min interval. ` +
        "Consider a longer interval, a higher-tier RPC endpoint, or a genuinely event-driven sync.",
    );
  }
}

async function main(): Promise<void> {
  const env = getEnv();
  await prisma.$connect();

  const client = createClient({ chain: studionet });
  const address = env.CLAIMGAME_CONTRACT_ADDRESS as `0x${string}`;

  // eslint-disable-next-line no-console
  console.log(`CLAIMGAME indexer starting — contract ${address} on studionet.`);

  // Runs forever on Fly.io (min_machines_running=1) — this is the process
  // that keeps the backend's read model live without ever being the
  // authority on funds or verdicts.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await tick(client, address);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Indexer tick failed, will retry next interval:", err);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal indexer boot error:", err);
  process.exit(1);
});
