#!/usr/bin/env node
/**
 * PRODUCT TEST 1/4 — Full claim lifecycle with a clear-cut win, including
 * amendment, objections, bounty, and the appeal circuit (or human-review
 * fallback, whichever the live judgment actually reaches — reported
 * honestly either way).
 *
 * Real dispute: Uniswap v4's PoolManager singleton architecture, backed by
 * the real v4-core README (confirmed live via curl before use).
 *
 * Exercises: register_protocol, create_claim, amend_claim, submit_evidence
 * (x2, two tiers), raise_objection, respond_to_objection, create_bounty,
 * contribute_to_bounty, submit_challenge, submit_for_judgment,
 * finalize_settlement (rejection path), raise_appeal OR
 * propose_human_settlement (branch on actual outcome), plus every relevant
 * read method.
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
    const value = await readJson(client, functionName, args);
    record(label || `read: ${functionName}`, true);
    return value;
  } catch (err) {
    record(label || `read: ${functionName}`, false, String(err).slice(0, 150));
    return null;
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
  const thirdParty = createAccount();
  const thirdPartyClient = createClient({ chain: studionet, account: thirdParty });
  await thirdPartyClient.request({ method: "sim_fundAccount", params: [thirdParty.address, 5000] });

  console.log("=== PRODUCT TEST 1/4: Full lifecycle (Uniswap v4) ===");
  console.log("Claimant:", claimant.address, "| Challenger:", challenger.address, "| Third party:", thirdParty.address);
  console.log("");

  await call(claimantClient, claimant, "register_protocol", ["Uniswap v4", "DeFi / AMM"], 0n, "register_protocol(Uniswap v4)");
  await readOk(readClient, "list_protocols", [], "read: list_protocols");

  const createResult = await call(
    claimantClient, claimant, "create_claim",
    [
      "Uniswap v4", "Protocol Claims",
      "PoolManager singleton architecture and hook state access",
      "Per the Uniswap v4-core README, v4-core uses a singleton-style architecture where all pool " +
        "state is managed in the PoolManager.sol contract, and pool actions are taken after an " +
        "initial call to unlock.",
      "Because all pool state lives in one singleton PoolManager contract rather than one contract " +
        "deployed per pool, v4 pools share a single contract instance instead of each pool having " +
        "its own separate deployed contract address, and hook contracts attached to one pool " +
        "execute within that same shared contract as every other pool.",
      "EASY", 21600,
    ],
    10n * ONE_GEN, "create_claim",
  );
  if (!createResult.ok) throw new Error("create_claim failed, aborting test 1");
  const claimId = String(await readJson(readClient, "get_claim_count", []));
  console.log("  Claim id:", claimId);

  await readOk(readClient, "get_claim", [claimId], "read: get_claim");
  await readOk(readClient, "get_claim_version", [claimId, 1], "read: get_claim_version");
  await readOk(readClient, "list_claim_versions", [claimId], "read: list_claim_versions");

  await call(
    claimantClient, claimant, "amend_claim",
    [claimId,
      "Because all pool state lives in one singleton PoolManager contract rather than one contract " +
        "deployed per pool, v4 pools share a single contract instance, and any hook attached to one " +
        "pool runs in that same shared contract address space as all other pools' hooks.",
      "Clarifying the shared-address-space consequence after re-reading the v4 core whitepaper."],
    0n, "amend_claim",
  );

  await call(
    claimantClient, claimant, "submit_evidence",
    [claimId, "PROTOCOL_DOCUMENTATION", "https://raw.githubusercontent.com/Uniswap/v4-core/main/README.md",
      "The v4-core repository's own README, directly stating the singleton-style architecture — PRIMARY-tier.", "SUPPORT"],
    0n, "submit_evidence #1 (PRIMARY-tier)",
  );
  await call(
    thirdPartyClient, thirdParty, "submit_evidence",
    [claimId, "FORUM_DISCUSSION", "https://gov.uniswap.org/",
      "Uniswap governance forum home — general venue discussing v4 architecture and hook safety, CORROBORATIVE-tier.", "NEUTRAL"],
    0n, "submit_evidence #2 (CORROBORATIVE-tier, third party)",
  );
  await readOk(readClient, "list_evidence_for_claim", [claimId], "read: list_evidence_for_claim");
  await readOk(readClient, "get_evidence", ["1"], "read: get_evidence(1)");

  await call(
    challengerClient, challenger, "raise_objection",
    [claimId, "The interpretation doesn't address whether hook state access is actually restricted " +
      "by the PoolKey/PoolId scoping described elsewhere in the docs, which may limit the practical " +
      "consequence of sharing one contract address."],
    0n, "raise_objection",
  );
  const objections = await readJson(readClient, "list_objections_for_claim", [claimId]).catch(() => []);
  await readOk(readClient, "list_objections_for_claim", [claimId], "read: list_objections_for_claim");
  if (objections?.[0]?.id) {
    await readOk(readClient, "get_objection", [objections[0].id], "read: get_objection");
    await call(
      claimantClient, claimant, "respond_to_objection",
      [objections[0].id, "Correct that PoolKey/PoolId scopes WHICH callbacks a hook receives, but " +
        "the claim is about shared contract STORAGE ADDRESS SPACE, not callback scoping — those are " +
        "different properties, and the storage-sharing point stands regardless of callback scoping."],
      0n, "respond_to_objection",
    );
  }

  await call(claimantClient, claimant, "create_bounty", [claimId, 2000, 3000, 5000], 500n * ONE_GEN, "create_bounty (500 GEN)");
  await call(thirdPartyClient, thirdParty, "contribute_to_bounty", [claimId], 50n * ONE_GEN, "contribute_to_bounty (+50 GEN)");
  await readOk(readClient, "get_bounty", [claimId], "read: get_bounty");

  await call(
    challengerClient, challenger, "submit_challenge",
    [claimId, "This claim overstates the risk: even though hooks share the PoolManager's contract " +
      "address, each hook callback only receives the PoolKey for the pool it's attached to, and " +
      "reading arbitrary other pools' state would require the hook code to deliberately query for " +
      "it — the architecture doesn't grant automatic cross-pool visibility just because storage is " +
      "technically shared."],
    10n * ONE_GEN, "submit_challenge",
  );
  await readOk(readClient, "get_challenge", [claimId], "read: get_challenge");
  await readOk(readClient, "list_claims_by_status", ["CHALLENGED"], "read: list_claims_by_status(CHALLENGED)");

  console.log("");
  console.log("  Submitting for judgment (real GenLayer consensus)...");
  const judgResult = await call(claimantClient, claimant, "submit_for_judgment", [claimId], 0n, "submit_for_judgment");
  const claimAfter = await readJson(readClient, "get_claim", [claimId]);
  await readOk(readClient, "get_claim", [claimId], "read: get_claim (post-judgment)");
  console.log("  Status after judgment:", claimAfter.status, judgResult.ok ? "" : "(judgment call itself disagreed — reported above)");

  if (claimAfter.status === "PENDING_APPEAL") {
    console.log("  Pending verdict:", claimAfter.pending_verdict, "payout_bps:", claimAfter.pending_payout_bps);
    await expectRejected(challengerClient, challenger, "finalize_settlement", [claimId], 0n, "finalize_settlement rejected (appeal window open)");
    const appealResult = await call(
      challengerClient, challenger, "raise_appeal",
      [claimId, "OFFICIAL_ANNOUNCEMENT", "https://raw.githubusercontent.com/Uniswap/v4-core/main/CHANGELOG.md",
        "New evidence submitted specifically for the appeal round — the v4-core changelog."],
      10n * ONE_GEN, "raise_appeal WITH new evidence",
    );
    if (appealResult.ok) {
      await readOk(readClient, "get_appeal", [claimId], "read: get_appeal");
      const appeal = await readJson(readClient, "get_appeal", [claimId]);
      console.log("  Appeal outcome:", appeal.outcome);
    }
  } else if (claimAfter.status === "NEEDS_HUMAN_REVIEW") {
    await readOk(readClient, "get_human_settlement_proposals", [claimId], "read: get_human_settlement_proposals (before)");
    await call(claimantClient, claimant, "propose_human_settlement", [claimId, 6000], 0n, "propose_human_settlement (claimant, 6000bps)");
    await call(challengerClient, challenger, "propose_human_settlement", [claimId, 6000], 0n, "propose_human_settlement (challenger agrees -> settles)");
    await readOk(readClient, "get_claim", [claimId], "read: get_claim (confirm settled)");
  } else if (claimAfter.status === "CHALLENGED") {
    console.log("  Judgment disagreed and left the claim CHALLENGED (unsettled, funds safe) — this is a real, honestly-reported consensus outcome, not a bug.");
  }

  await readOk(readClient, "get_reputation_events_for_user", [claimant.address], "read: get_reputation_events_for_user(claimant)");
  await readOk(readClient, "get_reputation_events_for_user", [challenger.address], "read: get_reputation_events_for_user(challenger)");
  await readOk(readClient, "get_reputation_event_count", [], "read: get_reputation_event_count");
  await readOk(readClient, "list_open_claim_ids", [], "read: list_open_claim_ids");
  await readOk(readClient, "get_claim_count", [], "read: get_claim_count");

  const passed = results.filter((r) => r.ok).length;
  console.log("");
  console.log(`=== TEST 1 SUMMARY: ${passed}/${results.length} checks passed ===`);
  for (const r of results.filter((r) => !r.ok)) console.log(`  FAILED: ${r.name} — ${r.detail}`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
});
