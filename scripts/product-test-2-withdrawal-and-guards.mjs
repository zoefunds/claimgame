#!/usr/bin/env node
/**
 * PRODUCT TEST 2/4 — Withdrawal mechanics, bounty refund, and deadline
 * guard-rail rejections (claim_expired before its window, submit_challenge
 * on a withdrawn claim, submit_evidence on an unknown claim).
 *
 * Real dispute: Compound v3 (Comet)'s single-base-asset market design,
 * backed by the real compound-protocol README.
 */
import { createClient, createAccount } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";

const CONTRACT_ADDRESS = process.env.CLAIMGAME_CONTRACT_ADDRESS || "0x7669F31fe5B91E7e7661f6C88a53351fb29662D1";
const ONE_GEN = 10n ** 18n;
const CALL_SPACING_MS = 2400;
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
  if (disagree > 0 && disagree >= agree) return { ok: false, message: `${disagree} disagree vs ${agree} agree`, votes };
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
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
}
async function call(client, account, functionName, args, value, label) {
  await throttle();
  const txHash = await client.writeContract({ address: CONTRACT_ADDRESS, functionName, args, value: value ?? 0n, account });
  const start = Date.now();
  await client.waitForTransactionReceipt({ hash: txHash, status: TransactionStatus.FINALIZED, retries: 150, interval: 3000 });
  await throttle();
  const tx = await client.getTransaction({ hash: txHash });
  const outcome = findVoteOutcome(tx);
  const secs = Math.round((Date.now() - start) / 1000);
  record(label || functionName, outcome.ok, outcome.ok ? `${secs}s` : `${secs}s — ${outcome.message}`);
  return { ok: outcome.ok, message: outcome.message };
}
async function expectRejected(client, account, functionName, args, value, label) {
  await throttle();
  try {
    const txHash = await client.writeContract({ address: CONTRACT_ADDRESS, functionName, args, value: value ?? 0n, account });
    await client.waitForTransactionReceipt({ hash: txHash, status: TransactionStatus.FINALIZED, retries: 150, interval: 3000 });
    await throttle();
    const tx = await client.getTransaction({ hash: txHash });
    const outcome = findVoteOutcome(tx);
    if (!outcome.ok) { record(label, true, `correctly rejected: ${outcome.message}`); return true; }
    record(label, false, "expected rejection but call succeeded");
    return false;
  } catch (err) {
    record(label, true, `correctly rejected: ${String(err).slice(0, 120)}`);
    return true;
  }
}
async function readJson(client, functionName, args) {
  await throttle();
  return JSON.parse(await client.readContract({ address: CONTRACT_ADDRESS, functionName, args }));
}
async function readOk(client, functionName, args, label) {
  try {
    await readJson(client, functionName, args);
    record(label || `read: ${functionName}`, true);
  } catch (err) {
    record(label || `read: ${functionName}`, false, String(err).slice(0, 150));
  }
}

async function main() {
  const readClient = createClient({ chain: studionet });
  const claimant = createAccount();
  const claimantClient = createClient({ chain: studionet, account: claimant });
  await claimantClient.request({ method: "sim_fundAccount", params: [claimant.address, 5000] });
  const challenger = createAccount();
  const challengerClient = createClient({ chain: studionet, account: challenger });
  await challengerClient.request({ method: "sim_fundAccount", params: [challenger.address, 5000] });

  console.log("=== PRODUCT TEST 2/4: Withdrawal mechanics + guard rails (Compound v3) ===");
  console.log("Claimant:", claimant.address, "| Challenger:", challenger.address);
  console.log("");

  await call(claimantClient, claimant, "register_protocol", ["Compound v3", "DeFi / Lending"], 0n, "register_protocol(Compound v3)");

  const createResult = await call(
    claimantClient, claimant, "create_claim",
    [
      "Compound v3", "Protocol Claims",
      "Compound v3 uses a single base asset per market, not pooled multi-asset lending",
      "Per the compound-protocol repository's own README, this repository contains the Solidity " +
        "source code for the Compound Protocol's smart contracts, with an automated CI/coverage " +
        "pipeline (CircleCI, codecov badges shown in the README).",
      "Compound v3 (Comet)'s architecture restricts each deployed market to exactly one borrowable " +
        "base asset, with other supported assets usable only as collateral — a structural change " +
        "from v2's shared pooled-lending model where multiple assets could each be borrowed from " +
        "the same shared pool.",
      "HARD", 21600,
    ],
    10n * ONE_GEN, "create_claim",
  );
  if (!createResult.ok) throw new Error("create_claim failed, aborting test 2");
  const claimId = String(await readJson(readClient, "get_claim_count", []));
  console.log("  Claim id:", claimId);

  await call(claimantClient, claimant, "create_bounty", [claimId, 3000, 3000, 4000], 100n * ONE_GEN, "create_bounty (100 GEN)");
  await readOk(readClient, "get_bounty", [claimId], "read: get_bounty (before withdraw)");

  await expectRejected(challengerClient, challenger, "claim_expired", [claimId], 0n, "claim_expired rejected (challenge window has not passed yet)");

  await call(claimantClient, claimant, "withdraw_claim", [claimId], 0n, "withdraw_claim");
  const claimAfter = await readJson(readClient, "get_claim", [claimId]);
  record("verify: claim status is WITHDRAWN", claimAfter.status === "WITHDRAWN", claimAfter.status);
  await readOk(readClient, "get_claim", [claimId], "read: get_claim (post-withdraw)");

  const bountyAfter = await readJson(readClient, "get_bounty", [claimId]);
  record("verify: bounty refunded (paid=true, total_deposited=0)", bountyAfter.paid === true && bountyAfter.total_deposited === "0", JSON.stringify(bountyAfter));

  await expectRejected(challengerClient, challenger, "submit_challenge", [claimId, "test challenge on withdrawn claim"], 10n * ONE_GEN, "submit_challenge rejected on WITHDRAWN claim");
  await expectRejected(claimantClient, claimant, "submit_evidence", ["999999", "URL", "https://example.org", "test", "SUPPORT"], 0n, "submit_evidence rejected on unknown claim id");
  await expectRejected(challengerClient, challenger, "claim_dispute_timeout", [claimId], 0n, "claim_dispute_timeout rejected (claim is WITHDRAWN, not NEEDS_HUMAN_REVIEW)");

  await readOk(readClient, "list_claims_by_status", ["WITHDRAWN"], "read: list_claims_by_status(WITHDRAWN)");
  await readOk(readClient, "get_claim_count", [], "read: get_claim_count");

  const passed = results.filter((r) => r.ok).length;
  console.log("");
  console.log(`=== TEST 2 SUMMARY: ${passed}/${results.length} checks passed ===`);
  for (const r of results.filter((r) => !r.ok)) console.log(`  FAILED: ${r.name} — ${r.detail}`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
});
