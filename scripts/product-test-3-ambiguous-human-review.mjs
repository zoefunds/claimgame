#!/usr/bin/env node
/**
 * PRODUCT TEST 3/4 — A genuinely ambiguous dispute, designed to exercise
 * the human-review recovery path (propose_human_settlement, mutual
 * agreement) and the claim_dispute_timeout guard rail.
 *
 * Real dispute: MakerDAO's Multi-Collateral Dai (dss) system — whether the
 * Emergency Shutdown mechanism's threshold is a fixed technical parameter
 * or itself governance-controlled — backed by the real dss README.
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

  console.log("=== PRODUCT TEST 3/4: Ambiguous dispute -> human review (MakerDAO) ===");
  console.log("Claimant:", claimant.address, "| Challenger:", challenger.address);
  console.log("");

  await call(claimantClient, claimant, "register_protocol", ["MakerDAO", "Governance / CDP"], 0n, "register_protocol(MakerDAO)");

  const createResult = await call(
    claimantClient, claimant, "create_claim",
    [
      "MakerDAO", "Governance Claims",
      "Emergency Shutdown threshold is a fixed technical parameter, independent of governance",
      "Per the MakerDAO dss repository's own README, this repository contains the core smart " +
        "contract code for Multi-Collateral Dai, including the Emergency Shutdown Module, described " +
        "as a high-level system assuming familiarity with the protocol's mechanics.",
      "Because the Emergency Shutdown Module's MKR burn threshold is set as a fixed contract " +
        "parameter at the code level, a sufficiently large MKR holder or coalition could trigger " +
        "emergency shutdown unilaterally by acquiring and burning the threshold amount, bypassing " +
        "the normal governance poll process entirely — a structural centralization risk baked " +
        "into the design rather than a governance-controlled safeguard.",
      "AMBIGUOUS", 21600,
    ],
    10n * ONE_GEN, "create_claim",
  );
  if (!createResult.ok) throw new Error("create_claim failed, aborting test 3");
  const claimId = String(await readJson(readClient, "get_claim_count", []));
  console.log("  Claim id:", claimId);

  await call(
    claimantClient, claimant, "submit_evidence",
    [claimId, "PROTOCOL_DOCUMENTATION", "https://raw.githubusercontent.com/makerdao/dss/master/README.md",
      "MakerDAO's own dss repository README, describing the core Multi-Collateral Dai system including Emergency Shutdown.", "SUPPORT"],
    0n, "submit_evidence",
  );
  await readOk(readClient, "list_evidence_for_claim", [claimId], "read: list_evidence_for_claim");

  await call(
    challengerClient, challenger, "submit_challenge",
    [claimId, "The Emergency Shutdown threshold itself was SET by a prior governance vote and " +
      "remains changeable by a future governance vote — it's a governance-configured trigger " +
      "condition, not a bypass of governance, so framing it as independent of governance control " +
      "is misleading even though no additional vote is needed to actually pull the trigger once " +
      "the threshold is met."],
    10n * ONE_GEN, "submit_challenge",
  );
  await readOk(readClient, "get_challenge", [claimId], "read: get_challenge");

  console.log("");
  console.log("  Submitting for judgment...");
  const judgResult = await call(claimantClient, claimant, "submit_for_judgment", [claimId], 0n, "submit_for_judgment");
  const claimAfter = await readJson(readClient, "get_claim", [claimId]);
  console.log("  Status after judgment:", claimAfter.status);

  if (claimAfter.status === "NEEDS_HUMAN_REVIEW") {
    await readOk(readClient, "get_human_settlement_proposals", [claimId], "read: get_human_settlement_proposals (before)");
    await readOk(readClient, "get_resolution", [claimId], "read: get_resolution");

    await expectRejected(challengerClient, challenger, "claim_dispute_timeout", [claimId], 0n, "claim_dispute_timeout rejected (7-day review deadline has not passed yet)");

    await call(claimantClient, claimant, "propose_human_settlement", [claimId, 5000], 0n, "propose_human_settlement (claimant, 5000bps)");
    await call(challengerClient, challenger, "propose_human_settlement", [claimId, 5000], 0n, "propose_human_settlement (challenger agrees -> settles)");
    await readOk(readClient, "get_claim", [claimId], "read: get_claim (confirm settled via mutual agreement)");
  } else if (claimAfter.status === "PENDING_APPEAL") {
    console.log("  Landed in PENDING_APPEAL instead of NEEDS_HUMAN_REVIEW — a determinate verdict was reached despite the ambiguous framing. Real outcome, reported as-is.");
    await readOk(readClient, "get_resolution", [claimId], "read: get_resolution");
  } else if (claimAfter.status === "CHALLENGED") {
    console.log("  Judgment disagreed, claim left CHALLENGED (funds safe, unsettled) — real, honestly-reported outcome.");
  }

  await readOk(readClient, "list_claims_by_status", ["NEEDS_HUMAN_REVIEW"], "read: list_claims_by_status(NEEDS_HUMAN_REVIEW)");
  await readOk(readClient, "get_claim_count", [], "read: get_claim_count");

  const passed = results.filter((r) => r.ok).length;
  console.log("");
  console.log(`=== TEST 3 SUMMARY: ${passed}/${results.length} checks passed ===`);
  for (const r of results.filter((r) => !r.ok)) console.log(`  FAILED: ${r.name} — ${r.detail}`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
});
