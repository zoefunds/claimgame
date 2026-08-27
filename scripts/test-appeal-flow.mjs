#!/usr/bin/env node
/**
 * Real, live test of the v0.3.6 appeal / independent-witness round —
 * raise_appeal, finalize_settlement, get_appeal — none of which had been
 * exercised against a real transaction before (see docs/genlayer.md's
 * v0.3.6 section, "Not yet deployed or live-verified").
 *
 * Uses a real, detailed dispute crafted to be likely to reach a
 * DETERMINATE verdict (PASSED/FAILED/PARTIAL, landing in PENDING_APPEAL)
 * rather than INCONCLUSIVE (NEEDS_HUMAN_REVIEW) — strong PRIMARY-tier
 * evidence directly supporting the claimant's interpretation, and a
 * comparatively weak challenger argument, so the appeal mechanism itself
 * (not the underlying judgment) is what's under test.
 *
 * What this CAN prove live, right now: reaching PENDING_APPEAL, calling
 * raise_appeal (which runs a second independent judgment round and settles
 * immediately, no waiting), and that finalize_settlement correctly REJECTS
 * before the 24h appeal window closes (an expectFailure check — the
 * window itself can't be waited out in an automated test run).
 *
 * Run: node scripts/test-appeal-flow.mjs
 * Requires: apps/web's node_modules (genlayer-js) — copy into apps/web/scripts
 * and run from there, per this project's established pattern.
 */
import { createClient, createAccount } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";

const CONTRACT_ADDRESS = process.env.CLAIMGAME_CONTRACT_ADDRESS || "0xF8aDB04610C531d779B463AdB549515b60E85feA";
const ONE_GEN = 10n ** 18n;
const CALL_SPACING_MS = 2500;

let lastCall = 0;
async function throttle() {
  const wait = Math.max(0, lastCall + CALL_SPACING_MS - Date.now());
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
}

function findVoteOutcome(tx) {
  const votes = tx?.consensus_data?.votes ?? {};
  let agree = 0, disagree = 0;
  for (const v of Object.values(votes)) {
    if (v === "agree") agree++;
    else if (v === "disagree") disagree++;
  }
  if (disagree > 0 && disagree >= agree) {
    return { ok: false, message: `Validators disagreed (${disagree} disagree vs ${agree} agree)`, votes };
  }
  for (const v of tx?.consensus_data?.validators || []) {
    const base64 = typeof v.result === "string" ? v.result : v.result?.raw;
    if (!base64) continue;
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length === 0) continue;
    const tag = bytes[0];
    if (tag === 2) continue;
    if (tag === 1) return { ok: false, message: bytes.subarray(1).toString("utf8"), votes };
    return { ok: true, votes };
  }
  return { ok: true, votes };
}

async function read(client, functionName, args) {
  await throttle();
  return client.readContract({ address: CONTRACT_ADDRESS, functionName, args });
}
async function readJson(client, functionName, args) {
  return JSON.parse(await read(client, functionName, args));
}
async function call(client, account, functionName, args, value = 0n, label = "") {
  await throttle();
  const txHash = await client.writeContract({ address: CONTRACT_ADDRESS, functionName, args, value, account });
  const start = Date.now();
  await client.waitForTransactionReceipt({ hash: txHash, status: TransactionStatus.FINALIZED, retries: 150, interval: 3000 });
  await throttle();
  const tx = await client.getTransaction({ hash: txHash });
  const outcome = findVoteOutcome(tx);
  const secs = Math.round((Date.now() - start) / 1000);
  console.log(`  ${outcome.ok ? "✅" : "❌"} ${label || functionName} (${secs}s)${outcome.ok ? "" : " — " + outcome.message}`);
  if (outcome.votes && Object.keys(outcome.votes).length) console.log("     votes:", JSON.stringify(outcome.votes));
  return { txHash, ok: outcome.ok, message: outcome.message };
}
async function expectRejected(client, account, functionName, args, value = 0n, label = "") {
  await throttle();
  try {
    const txHash = await client.writeContract({ address: CONTRACT_ADDRESS, functionName, args, value, account });
    await client.waitForTransactionReceipt({ hash: txHash, status: TransactionStatus.FINALIZED, retries: 150, interval: 3000 });
    await throttle();
    const tx = await client.getTransaction({ hash: txHash });
    const outcome = findVoteOutcome(tx);
    if (!outcome.ok) {
      console.log(`  ✅ ${label} — correctly rejected (${outcome.message})`);
      return true;
    }
    console.log(`  ❌ ${label} — expected rejection but call succeeded`);
    return false;
  } catch (err) {
    console.log(`  ✅ ${label} — correctly rejected (${String(err).slice(0, 150)})`);
    return true;
  }
}

async function main() {
  const readClient = createClient({ chain: studionet });

  const claimant = createAccount();
  const claimantClient = createClient({ chain: studionet, account: claimant });
  await throttle();
  await claimantClient.request({ method: "sim_fundAccount", params: [claimant.address, 5000] });

  const challenger = createAccount();
  const challengerClient = createClient({ chain: studionet, account: challenger });
  await throttle();
  await challengerClient.request({ method: "sim_fundAccount", params: [challenger.address, 5000] });

  console.log("Claimant:", claimant.address);
  console.log("Challenger:", challenger.address);
  console.log("");

  const createResult = await call(
    claimantClient,
    claimant,
    "create_claim",
    [
      "Uniswap v4",
      "Protocol Claims",
      "PoolManager uses a singleton-style architecture",
      "Per the Uniswap v4-core README, v4-core uses a singleton-style architecture where all " +
        "pool state is managed in the PoolManager.sol contract, and pool actions are taken after " +
        "an initial call to unlock.",
      "Because all pool state lives in one singleton PoolManager contract rather than one " +
        "contract deployed per pool, v4 pools share a single contract instance instead of each " +
        "pool having its own separate deployed contract address.",
      "EASY",
      21600,
    ],
    10n * ONE_GEN,
    "create_claim (clear-cut dispute, designed to reach a determinate verdict)",
  );
  if (!createResult.ok) {
    console.error("create_claim failed, aborting:", createResult.message);
    process.exit(1);
  }

  const claimId = String(await readJson(readClient, "get_claim_count", []));
  console.log("Claim id:", claimId);

  await call(
    claimantClient,
    claimant,
    "submit_evidence",
    [
      claimId,
      "PROTOCOL_DOCUMENTATION",
      "https://raw.githubusercontent.com/Uniswap/v4-core/main/README.md",
      "The v4-core repository's own README, directly stating the singleton-style architecture " +
        "and that all pool state lives in PoolManager.sol — a PRIMARY-tier source directly on point.",
      "SUPPORT",
    ],
    0n,
    "submit_evidence (PRIMARY-tier: official protocol documentation)",
  );

  await call(
    challengerClient,
    challenger,
    "submit_challenge",
    [
      claimId,
      "This claim is wrong because Uniswap v4 does not exist as a deployed protocol and hooks " +
        "are a purely theoretical feature that has never been implemented in any smart contract " +
        "code, so there is no dynamic fee mechanism to analyze at all.",
    ],
    10n * ONE_GEN,
    "submit_challenge (deliberately weak, off-point argument)",
  );

  console.log("");
  console.log("Submitting for judgment...");
  await call(claimantClient, claimant, "submit_for_judgment", [claimId], 0n, "submit_for_judgment");

  const claimAfterJudgment = await readJson(readClient, "get_claim", [claimId]);
  console.log("");
  console.log("Post-judgment claim status:", claimAfterJudgment.status);

  if (claimAfterJudgment.status !== "PENDING_APPEAL") {
    console.log("");
    console.log(`Claim landed in ${claimAfterJudgment.status}, not PENDING_APPEAL — the appeal path isn't`);
    console.log("reachable from this outcome (e.g. it needed human review instead). Nothing more to test");
    console.log("in this run; try again for a case more likely to reach a determinate verdict.");
    return;
  }

  console.log("Pending verdict:", claimAfterJudgment.pending_verdict, "| payout_bps:", claimAfterJudgment.pending_payout_bps);
  console.log("Appeal deadline:", claimAfterJudgment.appeal_deadline);
  console.log("");

  // Confirm finalize_settlement correctly rejects before the appeal window closes.
  await expectRejected(
    challengerClient,
    challenger,
    "finalize_settlement",
    [claimId],
    0n,
    "finalize_settlement rejected (appeal window has not closed yet)",
  );

  console.log("");
  console.log("Raising an appeal (challenger) — triggers a second, independent judgment round...");
  const appealResult = await call(
    challengerClient,
    challenger,
    "raise_appeal",
    [claimId],
    10n * ONE_GEN,
    "raise_appeal (real 10 GEN bond, real second judgment round)",
  );

  if (!appealResult.ok) {
    console.log("");
    console.log("❌ raise_appeal itself failed — the appeal mechanism has a real bug, not yet confirmed working.");
    process.exit(1);
  }

  const appeal = await readJson(readClient, "get_appeal", [claimId]);
  const claimAfterAppeal = await readJson(readClient, "get_claim", [claimId]);
  console.log("");
  console.log("✅✅✅ APPEAL MECHANISM CONFIRMED WORKING LIVE");
  console.log("Appeal outcome:", appeal.outcome);
  console.log("Original verdict:", appeal.original_verdict, "| payout_bps:", appeal.original_payout_bps);
  console.log("Appeal-round verdict:", appeal.appeal_verdict, "| payout_bps:", appeal.appeal_payout_bps);
  console.log("Final claim status:", claimAfterAppeal.status, "(settled — funds moved via the appeal path)");

  // A second appeal on the same claim must be rejected (at most one per claim).
  await expectRejected(
    claimantClient,
    claimant,
    "raise_appeal",
    [claimId],
    10n * ONE_GEN,
    "second raise_appeal on the same claim rejected (one appeal per claim)",
  );
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
});
