#!/usr/bin/env node
/**
 * THE critical re-verification test (audit finding #6): does the v0.3.2
 * tightened fact-extraction prompt (exactly 3 verbatim quotes, 1500-char
 * excerpt, loosened equivalence instruction) actually resolve the
 * validator-disagreement incident from v0.3.0/v0.3.1, where the SAME raw
 * GitHub markdown evidence caused two consecutive real consensus failures
 * (majority "disagree" votes, zero state change)?
 *
 * Runs against the currently deployed contract (set CONTRACT_ADDRESS below)
 * with the identical evidence URL and a similar real dispute, so this is
 * as close to a controlled re-test as a live network allows.
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
  let agree = 0,
    disagree = 0;
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
      "PoolManager singleton architecture and hook state access",
      "Per the Uniswap v4-core README, all pool state is managed in a single PoolManager.sol " +
        "contract using a singleton-style architecture, and pools can optionally be initialized " +
        "with a hook contract implementing before/after callbacks for swap, add/remove liquidity, " +
        "and donate actions.",
      "Because state is centralized in one PoolManager contract shared by every pool, a hook " +
        "attached to one pool executes within that same shared contract as all other pools, " +
        "meaning a sufficiently privileged hook could technically read cross-pool state during " +
        "its callback, not just data isolated to the single pool it was attached to.",
      "HARD",
      21600,
    ],
    10n * ONE_GEN,
    "create_claim (identical dispute to the v0.3.0 failure case)",
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
      "The v4-core repository's own README, raw markdown — the EXACT SAME URL that caused two " +
        "consecutive validator-disagreement failures under the pre-v0.3.2 extraction prompt.",
      "SUPPORT",
    ],
    0n,
    "submit_evidence (same URL that failed twice before)",
  );

  await call(
    challengerClient,
    challenger,
    "submit_challenge",
    [
      claimId,
      "The singleton architecture centralizes CONTRACT STORAGE, not unscoped access — the README " +
        "describes hooks receiving callbacks tied to actions on their OWN pool (identified by a " +
        "PoolKey/PoolId), not an open door to arbitrary cross-pool state.",
    ],
    10n * ONE_GEN,
    "submit_challenge",
  );

  console.log("");
  console.log("Submitting for judgment — THE critical re-test (real GenLayer LLM + validator consensus)...");
  const judgmentResult = await call(claimantClient, claimant, "submit_for_judgment", [claimId], 0n, "submit_for_judgment");

  console.log("");
  if (judgmentResult.ok) {
    console.log("✅✅✅ LIVENESS FIX CONFIRMED — validators reached consensus this time.");
    const resolution = await readJson(readClient, "get_resolution", [claimId]);
    console.log("VERDICT:", resolution.verdict, "| confidence:", resolution.confidence, "| payout_bps:", resolution.payout_bps);
    console.log("Reasoning:", resolution.reasoning_summary);
    const evidence = await readJson(readClient, "list_evidence_for_claim", [claimId]);
    for (const item of evidence) {
      console.log(`Evidence: ${item.url}`);
      console.log(`  retrieved_at: ${item.retrieved_at}, content_hash (sha256): ${item.content_hash}, cited: ${item.cited_in_verdict}`);
    }
  } else {
    console.log("❌❌❌ LIVENESS FIX NOT CONFIRMED — validators still disagreed on the same evidence.");
    console.log("This means the v0.3.2 extraction-prompt tightening was insufficient; needs a different approach");
    console.log("(e.g. an even smaller excerpt, a fixed single-quote extraction, or moving off free-text LLM");
    console.log("comparison entirely for this evidence type).");
  }

  const claimAfter = await readJson(readClient, "get_claim", [claimId]);
  console.log("");
  console.log("Final claim status:", claimAfter.status);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
});
