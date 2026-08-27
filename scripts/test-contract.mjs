#!/usr/bin/env node
/**
 * CLAIMGAME contract integration test — exercises every public read/write
 * method on the LIVE deployed StudioNet contract with real, detailed data
 * (not placeholders): a real Uniswap v4 fee-exemption claim, a real
 * counter-argument, and real evidence URLs, so the judgment step's
 * evidence-fetch + fact-extraction path (audit fix #1) gets genuinely
 * exercised against live web content, not a stub.
 *
 * Run: node scripts/test-contract.mjs
 * Requires: apps/web's node_modules (genlayer-js) — run from repo root
 * after `pnpm install`.
 * Override the target contract with CLAIMGAME_CONTRACT_ADDRESS=0x... —
 * defaults to the current deployed v0.3.5 address. A prior audit correctly
 * flagged this script hardcoding a stale address as a reproducibility gap
 * (docs/genlayer.md's test-run writeups couldn't actually be re-run against
 * the address they claimed to test); this is the fix.
 *
 * Every claim/evidence/challenge/objection/bounty created here lands on
 * the real deployed contract, so it is automatically visible on the live
 * frontend (Hunt Board / claim detail / My Cases) within one indexer
 * cycle (~5s) — nothing here is a mock or a local simulation.
 */

import { createClient, createAccount } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";

const CONTRACT_ADDRESS = process.env.CLAIMGAME_CONTRACT_ADDRESS || "0x4a4E1a6C3349E88707158fb15bE2F0f6560029Da";
const ONE_GEN = 10n ** 18n;
const FUND_AMOUNT = 5000; // GEN, per sim_fundAccount's whole-GEN unit

const results = [];
let currentStep = "";

function log(...args) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);
}

async function step(name, fn) {
  currentStep = name;
  const startedAt = Date.now();
  try {
    const value = await fn();
    const ms = Date.now() - startedAt;
    results.push({ name, status: "PASS", ms, detail: value !== undefined ? JSON.stringify(value).slice(0, 300) : "" });
    log(`✅ PASS  (${ms}ms)  ${name}`);
    return value;
  } catch (err) {
    const ms = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, status: "FAIL", ms, detail: message.slice(0, 500) });
    log(`❌ FAIL  (${ms}ms)  ${name} — ${message.slice(0, 300)}`);
    return null;
  }
}

async function expectFailure(name, fn) {
  currentStep = name;
  const startedAt = Date.now();
  try {
    await fn();
    const ms = Date.now() - startedAt;
    results.push({ name, status: "FAIL", ms, detail: "expected a UserError but the call succeeded" });
    log(`❌ FAIL  (${ms}ms)  ${name} — expected rejection but call succeeded`);
    return false;
  } catch (err) {
    const ms = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, status: "PASS", ms, detail: `correctly rejected: ${message.slice(0, 200)}` });
    log(`✅ PASS  (${ms}ms)  ${name} — correctly rejected (${message.slice(0, 120)})`);
    return true;
  }
}

/**
 * IMPORTANT, confirmed-by-testing finding: genlayer-js@1.1.8's
 * `waitForTransactionReceipt()` return value does NOT carry the camelCase
 * `statusName`/`txExecutionResultName` fields its own TypeScript types
 * declare (`GenLayerTransaction`) — the real runtime object uses
 * `status_name` (snake_case), and there is no `txExecutionResultName`
 * field at all. Whether the contract itself raised (a `gl.vm.UserError`)
 * is NOT on the receipt — it's inside `consensus_data.validators[].result`
 * on the object returned by `getTransaction({hash})`:
 *   - success:  result is a bare base64 STRING (the encoded return value)
 *   - rollback: result is an OBJECT `{ raw, status: "rollback", payload }`
 *     where `payload` is the human-readable error message (e.g. "Only owner")
 * This was silently wrong in the deployed frontend too (see
 * apps/web/lib/contract.ts) — it was checking `receipt.txExecutionResultName`,
 * a field that never exists, so it always fell through to treating any
 * FINALIZED/ACCEPTED transaction as a domain success even when the
 * contract had actually raised. Fixed here and ported back to the app.
 */
/**
 * A validator's vote `result` is genvm-internal calldata: base64 bytes
 * whose FIRST byte is a tag — confirmed empirically against the live
 * contract (both shapes occur: sometimes genlayer-js wraps it as
 * `{ raw, status: "rollback", payload }`, sometimes it's left as a bare
 * base64 string — the object wrapper is NOT reliable to detect on its own,
 * decoding the actual bytes is):
 *   0x00 = success (rest of bytes is the encoded return value)
 *   0x01 = rollback / gl.vm.UserError raised (rest of bytes is the UTF-8
 *          error message)
 *   0x02 = "idle" placeholder (validator didn't independently execute —
 *          not a real result, skip it)
 */
function decodeVoteResult(raw) {
  const base64 = typeof raw === "string" ? raw : raw?.raw;
  if (!base64) return { tag: null, ok: true };
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0) return { tag: null, ok: true };
  const tag = bytes[0];
  if (tag === 1) {
    const fromBytes = bytes.subarray(1).toString("utf8");
    return { tag, ok: false, message: (typeof raw === "object" && raw?.payload) || fromBytes };
  }
  if (tag === 2) return { tag, ok: null }; // idle — not a real result
  return { tag, ok: true };
}

function findRepresentativeVoteOutcome(tx) {
  const validators = tx?.consensus_data?.validators || [];
  for (const v of validators) {
    const decoded = decodeVoteResult(v.result);
    if (decoded.ok !== null) return decoded; // skip idle votes only
  }
  return { tag: null, ok: true };
}

async function writeAndWait(client, functionName, args, options = {}) {
  const account = options.account;
  const txHash = await client.writeContract({
    address: CONTRACT_ADDRESS,
    functionName,
    args,
    value: options.value ?? 0n,
    account,
  });
  const receipt = await client.waitForTransactionReceipt({
    hash: txHash,
    status: TransactionStatus.FINALIZED,
    retries: 60,
    interval: 3000,
  });
  const statusName = receipt.status_name;
  if (process.env.DEBUG_RECEIPT) {
    console.log("RAW RECEIPT for", functionName, JSON.stringify(receipt, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  }
  if (statusName === "UNDETERMINED") {
    throw new Error(`UNDETERMINED consensus result for ${functionName} (tx ${txHash})`);
  }
  if (statusName !== "FINALIZED" && statusName !== "ACCEPTED") {
    throw new Error(`Unexpected terminal status "${statusName}" for ${functionName} (tx ${txHash})`);
  }

  const tx = await client.getTransaction({ hash: txHash });
  const outcome = findRepresentativeVoteOutcome(tx);
  if (!outcome.ok) {
    throw new Error(`Contract raised on ${functionName}: ${outcome.message} (tx ${txHash})`);
  }

  return { txHash };
}

async function main() {
  log("=== CLAIMGAME contract test — live StudioNet ===");
  log("Contract:", CONTRACT_ADDRESS);

  const readClient = createClient({ chain: studionet });

  const claimantAccount = createAccount();
  const challengerAccount = createAccount();
  log("Claimant account:", claimantAccount.address);
  log("Challenger account:", challengerAccount.address);

  const claimantClient = createClient({ chain: studionet, account: claimantAccount });
  const challengerClient = createClient({ chain: studionet, account: challengerAccount });

  // ---------------------------------------------------------------------
  // FUNDING (StudioNet simulator faucet — sandbox GEN, no real value)
  // ---------------------------------------------------------------------
  await step("fund claimant account via sim_fundAccount", async () => {
    await claimantClient.request({ method: "sim_fundAccount", params: [claimantAccount.address, FUND_AMOUNT] });
  });
  await step("fund challenger account via sim_fundAccount", async () => {
    await challengerClient.request({ method: "sim_fundAccount", params: [challengerAccount.address, FUND_AMOUNT] });
  });
  await step("verify claimant balance > 0", async () => {
    const bal = await readClient.getBalance({ address: claimantAccount.address });
    if (bal <= 0n) throw new Error("balance still zero after funding");
    return bal.toString();
  });
  await step("verify challenger balance > 0", async () => {
    const bal = await readClient.getBalance({ address: challengerAccount.address });
    if (bal <= 0n) throw new Error("balance still zero after funding");
    return bal.toString();
  });

  // ---------------------------------------------------------------------
  // READS — baseline, before any writes
  // ---------------------------------------------------------------------
  await step("read: get_owner", () => readClient.readContract({ address: CONTRACT_ADDRESS, functionName: "get_owner", args: [] }));
  await step("read: get_claim_count", () => readClient.readContract({ address: CONTRACT_ADDRESS, functionName: "get_claim_count", args: [] }));
  await step("read: list_open_claim_ids", () => readClient.readContract({ address: CONTRACT_ADDRESS, functionName: "list_open_claim_ids", args: [] }));
  await step("read: list_protocols", () => readClient.readContract({ address: CONTRACT_ADDRESS, functionName: "list_protocols", args: [] }));
  await step("read: get_reputation_event_count", () => readClient.readContract({ address: CONTRACT_ADDRESS, functionName: "get_reputation_event_count", args: [] }));

  // ---------------------------------------------------------------------
  // ADMIN — permissionless registry write + owner-gated access control
  // ---------------------------------------------------------------------
  await step("write: register_protocol(Uniswap v4, DeFi/AMM)", () =>
    writeAndWait(claimantClient, "register_protocol", ["Uniswap v4", "DeFi / AMM"], { account: claimantAccount }),
  );
  await expectFailure("write: create_season rejected for non-owner", () =>
    writeAndWait(claimantClient, "create_season", ["Season 01", "2026-01-01T00:00:00Z", "2026-04-01T00:00:00Z"], {
      account: claimantAccount,
    }),
  );
  await expectFailure("write: transfer_ownership rejected for non-owner", () =>
    writeAndWait(claimantClient, "transfer_ownership", [claimantAccount.address], { account: claimantAccount }),
  );

  // ---------------------------------------------------------------------
  // CLAIM #1 — real, detailed Uniswap v4 dispute, taken through the full
  // create -> evidence -> challenge -> judgment lifecycle.
  // ---------------------------------------------------------------------
  const sourceStatement =
    "Uniswap v4 hooks can charge a swap fee up to 100% (1,000,000 in the pip-denominated fee " +
    "unit) on top of the pool's LP fee, and this hook-level fee is NOT subject to governance " +
    "approval or the protocol fee cap that applies to LP fees, per the Uniswap v4 core " +
    "documentation's description of dynamic and hook fees.";
  const interpretation =
    "Because hook fees bypass the protocol-fee governance cap entirely, any pool deployed with " +
    "a fee-charging hook effectively lets the hook deployer unilaterally set an unbounded tax on " +
    "every swap through that pool, with no on-chain mechanism for LPs or swappers to cap it " +
    "short of not using that hook.";

  const claimId = await step("write: create_claim (real Uniswap v4 hook-fee dispute, 10 GEN bond)", async () => {
    const { receipt } = await writeAndWait(
      claimantClient,
      "create_claim",
      [
        "Uniswap v4",
        "Protocol Claims",
        "Hook-level swap fees bypass governance fee cap",
        sourceStatement,
        interpretation,
        "HARD",
        21600, // 6h challenge window (contract minimum)
      ],
      { account: claimantAccount, value: 10n * ONE_GEN },
    );
    void receipt;
    // create_claim's return value isn't reliably exposed on the receipt
    // (see apps/web/lib/contract.ts) — re-derive it the same way the
    // frontend does: sequential ids, so it's the current total count.
    const count = await readClient.readContract({ address: CONTRACT_ADDRESS, functionName: "get_claim_count", args: [] });
    return String(count);
  });

  if (!claimId) {
    log("Cannot continue claim lifecycle tests — create_claim failed.");
  } else {
    log("Using claim id:", claimId);

    await step("read: get_claim", () => readClient.readContract({ address: CONTRACT_ADDRESS, functionName: "get_claim", args: [claimId] }));
    await step("read: get_claim_version(1)", () =>
      readClient.readContract({ address: CONTRACT_ADDRESS, functionName: "get_claim_version", args: [claimId, 1] }),
    );
    await step("read: list_claim_versions", () =>
      readClient.readContract({ address: CONTRACT_ADDRESS, functionName: "list_claim_versions", args: [claimId] }),
    );

    await step("write: amend_claim (claimant refines interpretation)", () =>
      writeAndWait(
        claimantClient,
        "amend_claim",
        [
          claimId,
          interpretation +
            " Concretely: a hook could set the fee to the 100% ceiling and drain the entire " +
            "swap input, and no governance vote is required to permit or block this.",
          "Clarifying the concrete worst case after re-reading the v4 core whitepaper.",
        ],
        { account: claimantAccount },
      ),
    );

    // Real evidence: Uniswap's own v4 documentation and a real governance
    // forum discussion of hook fee risk — genuine URLs, genuine content,
    // so the contract's live web-fetch + fact-extraction step (audit fix
    // #1) is exercised against real pages, not placeholder text.
    await step("write: submit_evidence #1 (Uniswap v4 docs, SUPPORT)", () =>
      writeAndWait(
        claimantClient,
        "submit_evidence",
        [
          claimId,
          "PROTOCOL_DOCUMENTATION",
          "https://docs.uniswap.org/contracts/v4/concepts/dynamic-fees",
          "Uniswap's own v4 documentation describing how hooks can implement dynamic and " +
            "arbitrary swap fees independent of the LP fee tier.",
          "SUPPORT",
        ],
        { account: claimantAccount },
      ),
    );
    await step("write: submit_evidence #2 (Uniswap governance forum, NEUTRAL)", () =>
      writeAndWait(
        challengerClient,
        "submit_evidence",
        [
          claimId,
          "FORUM_DISCUSSION",
          "https://gov.uniswap.org/",
          "Uniswap governance forum home — general venue where hook fee risk and safety " +
            "guidance has been discussed by the Uniswap Foundation and community.",
          "NEUTRAL",
        ],
        { account: challengerAccount },
      ),
    );

    await step("write: raise_objection (challenger flags a gap)", () =>
      writeAndWait(
        challengerClient,
        "raise_objection",
        [
          claimId,
          "The interpretation doesn't mention that PoolManager still enforces a global max fee " +
            "constant for hooks, which may cap the practical worst case below 100% depending on " +
            "which fee flag is set.",
        ],
        { account: challengerAccount },
      ),
    );

    const objectionsForRespond = await step("read: list_objections_for_claim (to get id for respond)", () =>
      readClient.readContract({ address: CONTRACT_ADDRESS, functionName: "list_objections_for_claim", args: [claimId] }),
    );
    const firstObjectionId = objectionsForRespond ? JSON.parse(objectionsForRespond)[0]?.id : null;
    if (firstObjectionId) {
      await step("write: respond_to_objection", () =>
        writeAndWait(
          claimantClient,
          "respond_to_objection",
          [
            firstObjectionId,
            "Acknowledged — the cap exists at the protocol level, but the claim is specifically " +
              "about governance approval, not an absolute ceiling; the max is fixed in code, not " +
              "voted on per-pool, which is the actual point in dispute.",
          ],
          { account: claimantAccount },
        ),
      );
    }

    await step("write: create_bounty (500 GEN, 20/30/50 split)", () =>
      writeAndWait(claimantClient, "create_bounty", [claimId, 2000, 3000, 5000], {
        account: claimantAccount,
        value: 500n * ONE_GEN,
      }),
    );
    await step("write: contribute_to_bounty (+100 GEN from challenger)", () =>
      writeAndWait(challengerClient, "contribute_to_bounty", [claimId], {
        account: challengerAccount,
        value: 100n * ONE_GEN,
      }),
    );
    await step("read: get_bounty", () => readClient.readContract({ address: CONTRACT_ADDRESS, functionName: "get_bounty", args: [claimId] }));

    await step(
      "write: submit_challenge (real counter-argument, 10 GEN stake)",
      () =>
        writeAndWait(
          challengerClient,
          "submit_challenge",
          [
            claimId,
            "Uniswap v4's PoolManager hardcodes MAX_LP_FEE and hook fee flags such that " +
              "hook-charged fees, while not routed through the same governance-controlled " +
              "protocolFee mechanism as LP fees, are still bounded by fixed on-chain constants " +
              "in the core contract, not left fully unbounded. The claim's 'no cap short of not " +
              "using the hook' framing overstates the risk: the ceiling is enforced by immutable " +
              "code, not by hook discretion, so calling it ungoverned is misleading even though " +
              "it is technically true that no DAO vote gates it per-pool.",
            ],
          { account: challengerAccount, value: 10n * ONE_GEN },
        ),
    );

    await step("read: get_challenge", () => readClient.readContract({ address: CONTRACT_ADDRESS, functionName: "get_challenge", args: [claimId] }));

    await step("read: list_claims_by_status(CHALLENGED)", () =>
      readClient.readContract({ address: CONTRACT_ADDRESS, functionName: "list_claims_by_status", args: ["CHALLENGED"] }),
    );

    // -----------------------------------------------------------------
    // THE core test: real GenLayer judgment — live web fetch, LLM
    // fact-extraction (audit fix #1), Equivalence Principle consensus.
    // This is the step most likely to surface a GenVM/consensus error if
    // one exists, so it gets its own explicit pass/fail reporting below
    // in addition to the standard step() wrapper.
    // -----------------------------------------------------------------
    log("Submitting for judgment — this triggers a real GenLayer LLM call + validator consensus, may take 30-90s...");
    await step("write: submit_for_judgment (REAL GenLayer consensus)", () =>
      writeAndWait(claimantClient, "submit_for_judgment", [claimId], { account: claimantAccount }),
    );

    const claimAfterJudgment = await step("read: get_claim (post-judgment status)", () =>
      readClient.readContract({ address: CONTRACT_ADDRESS, functionName: "get_claim", args: [claimId] }),
    );
    const resolution = await step("read: get_resolution", () =>
      readClient.readContract({ address: CONTRACT_ADDRESS, functionName: "get_resolution", args: [claimId] }),
    );
    if (resolution) {
      log("VERDICT:", resolution);
    }

    await step("read: list_evidence_for_claim (verify Evidence Manifest populated)", async () => {
      const raw = await readClient.readContract({ address: CONTRACT_ADDRESS, functionName: "list_evidence_for_claim", args: [claimId] });
      const items = JSON.parse(raw);
      const withManifest = items.filter((e) => e.retrieved_at && e.content_hash);
      log(`  ${withManifest.length}/${items.length} evidence items have retrieved_at + content_hash populated`);
      if (withManifest.length === 0) {
        throw new Error("no evidence item got Evidence Manifest fields populated during judgment");
      }
      return withManifest.map((e) => ({ id: e.id, content_hash: e.content_hash }));
    });

    const claimStatus = claimAfterJudgment ? JSON.parse(claimAfterJudgment).status : null;
    log("Post-judgment claim status:", claimStatus);

    if (claimStatus === "NEEDS_HUMAN_REVIEW") {
      log("Verdict landed in NEEDS_HUMAN_REVIEW — testing the human-settlement recovery path.");
      await step("read: get_human_settlement_proposals (before any proposal)", () =>
        readClient.readContract({ address: CONTRACT_ADDRESS, functionName: "get_human_settlement_proposals", args: [claimId] }),
      );
      await step("write: propose_human_settlement (claimant proposes 7000 bps)", () =>
        writeAndWait(claimantClient, "propose_human_settlement", [claimId, 7000], { account: claimantAccount }),
      );
      await step("write: propose_human_settlement (challenger agrees, 7000 bps -> auto-settles)", () =>
        writeAndWait(challengerClient, "propose_human_settlement", [claimId, 7000], { account: challengerAccount }),
      );
      await step("read: get_claim (confirm settled via mutual agreement)", () =>
        readClient.readContract({ address: CONTRACT_ADDRESS, functionName: "get_claim", args: [claimId] }),
      );
    } else {
      log("Verdict resolved directly (no human review needed) — claim_dispute_timeout / propose_human_settlement not applicable to this claim.");
    }
  }

  // ---------------------------------------------------------------------
  // CLAIM #2 — exercises withdraw_claim + bounty refund path (audit fix #4)
  // ---------------------------------------------------------------------
  const claimId2 = await step("write: create_claim #2 (for withdraw + bounty-refund test)", async () => {
    await writeAndWait(
      claimantClient,
      "create_claim",
      [
        "MakerDAO",
        "Governance Claims",
        "Emergency Shutdown Module quorum requirement",
        "MakerDAO's Emergency Shutdown Module (ESM) requires a fixed MKR threshold to be " +
          "deposited before shutdown can be triggered, independent of any active governance " +
          "poll or executive vote outcome, per the MCD (Multi-Collateral Dai) technical " +
          "documentation describing the ESM contract.",
        "Since the MKR threshold is a fixed contract parameter, a sufficiently large MKR " +
          "holder (or a coalition) can trigger emergency shutdown unilaterally, bypassing the " +
          "normal governance poll process entirely, as long as they can acquire and burn the " +
          "threshold amount of MKR.",
        "AMBIGUOUS",
        21600,
      ],
      { account: claimantAccount, value: 10n * ONE_GEN },
    );
    const count = await readClient.readContract({ address: CONTRACT_ADDRESS, functionName: "get_claim_count", args: [] });
    return String(count);
  });

  if (claimId2) {
    await step("write: create_bounty on claim #2 (50 GEN)", () =>
      writeAndWait(claimantClient, "create_bounty", [claimId2, 3000, 3000, 4000], {
        account: claimantAccount,
        value: 50n * ONE_GEN,
      }),
    );
    await step("write: withdraw_claim (before any challenge)", () =>
      writeAndWait(claimantClient, "withdraw_claim", [claimId2], { account: claimantAccount }),
    );
    await step("read: get_claim #2 (confirm WITHDRAWN)", async () => {
      const raw = await readClient.readContract({ address: CONTRACT_ADDRESS, functionName: "get_claim", args: [claimId2] });
      const claim = JSON.parse(raw);
      if (claim.status !== "WITHDRAWN") throw new Error(`expected WITHDRAWN, got ${claim.status}`);
      return claim.status;
    });
    await step("read: get_bounty #2 (confirm refunded — paid=true, total_deposited=0)", async () => {
      const raw = await readClient.readContract({ address: CONTRACT_ADDRESS, functionName: "get_bounty", args: [claimId2] });
      const bounty = JSON.parse(raw);
      if (!bounty.paid || bounty.total_deposited !== "0") {
        throw new Error(`bounty not refunded: ${raw}`);
      }
      return bounty;
    });
  }

  // ---------------------------------------------------------------------
  // Access control / deadline enforcement checks (audit fix #5)
  // ---------------------------------------------------------------------
  if (claimId2) {
    await expectFailure("write: submit_challenge rejected on a WITHDRAWN claim", () =>
      writeAndWait(challengerClient, "submit_challenge", [claimId2, "test"], {
        account: challengerAccount,
        value: 10n * ONE_GEN,
      }),
    );
  }
  await expectFailure("write: submit_evidence rejected on unknown claim id", () =>
    writeAndWait(claimantClient, "submit_evidence", ["999999", "URL", "https://example.org", "test", "SUPPORT"], {
      account: claimantAccount,
    }),
  );

  // ---------------------------------------------------------------------
  // Reputation reads
  // ---------------------------------------------------------------------
  await step("read: get_reputation_events_for_user (claimant)", () =>
    readClient.readContract({ address: CONTRACT_ADDRESS, functionName: "get_reputation_events_for_user", args: [claimantAccount.address] }),
  );
  await step("read: get_reputation_events_for_user (challenger)", () =>
    readClient.readContract({ address: CONTRACT_ADDRESS, functionName: "get_reputation_events_for_user", args: [challengerAccount.address] }),
  );
  await step("read: get_claim_count (final)", () => readClient.readContract({ address: CONTRACT_ADDRESS, functionName: "get_claim_count", args: [] }));
  await step("read: list_open_claim_ids (final)", () => readClient.readContract({ address: CONTRACT_ADDRESS, functionName: "list_open_claim_ids", args: [] }));

  // ---------------------------------------------------------------------
  // SUMMARY
  // ---------------------------------------------------------------------
  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  log("");
  log("=== SUMMARY ===");
  log(`${passed} passed, ${failed} failed, ${results.length} total`);
  if (failed > 0) {
    log("FAILURES:");
    for (const r of results.filter((r) => r.status === "FAIL")) {
      log(`  - ${r.name}: ${r.detail}`);
    }
  }
  log("");
  log("Claim ids created (visible on frontend within one indexer cycle):", [claimId, claimId2].filter(Boolean).join(", "));
  log("Claimant:", claimantAccount.address);
  log("Challenger:", challengerAccount.address);

  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error("FATAL:", currentStep, err);
  process.exitCode = 1;
});
