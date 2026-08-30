#!/usr/bin/env node
/**
 * PRODUCT TEST 4/4 — Protocol registry and validator-verified official
 * domains, plus a real positive case and a negative control.
 *
 * Real case: OpenZeppelin's actual GitHub org website field is
 * openzeppelin.com (confirmed live via curl before use, NOT .org).
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
  const proposer = createAccount();
  const proposerClient = createClient({ chain: studionet, account: proposer });
  await proposerClient.request({ method: "sim_fundAccount", params: [proposer.address, 100] });

  console.log("=== PRODUCT TEST 4/4: Protocol registry & source verification (OpenZeppelin) ===");
  console.log("Proposer:", proposer.address);
  console.log("");

  await call(proposerClient, proposer, "register_protocol", ["OpenZeppelin Contracts", "Security / Tooling"], 0n, "register_protocol(OpenZeppelin Contracts)");
  await readOk(readClient, "list_protocols", [], "read: list_protocols");

  await call(
    proposerClient, proposer, "propose_official_domain",
    ["OpenZeppelin Contracts", "openzeppelin.com", "OpenZeppelin"],
    5n * ONE_GEN, "propose_official_domain(OpenZeppelin Contracts, openzeppelin.com, OpenZeppelin)",
  );
  const proposalId1 = String(await readJson(readClient, "get_domain_proposal_count", []));
  await readOk(readClient, "get_domain_proposal_count", [], "read: get_domain_proposal_count");
  console.log("  Proposal id:", proposalId1);

  await call(proposerClient, proposer, "verify_official_domain", [proposalId1], 0n, "verify_official_domain — real case (THE consensus check)");
  const proposal1 = await readJson(readClient, "get_domain_proposal", [proposalId1]);
  await readOk(readClient, "get_domain_proposal", [proposalId1], "read: get_domain_proposal");
  console.log("  Status:", proposal1.status, "| verification_result:", proposal1.verification_result);
  record("verify: openzeppelin.com became VERIFIED", proposal1.status === "VERIFIED", proposal1.status);

  console.log("");
  console.log("  --- Negative control ---");
  await call(
    proposerClient, proposer, "propose_official_domain",
    ["OpenZeppelin Contracts", "not-actually-openzeppelin.example", "OpenZeppelin"],
    5n * ONE_GEN, "propose_official_domain — mismatched domain",
  );
  const proposalId2 = String(await readJson(readClient, "get_domain_proposal_count", []));
  await call(proposerClient, proposer, "verify_official_domain", [proposalId2], 0n, "verify_official_domain — should REJECT");
  const proposal2 = await readJson(readClient, "get_domain_proposal", [proposalId2]);
  console.log("  Status:", proposal2.status, "| verification_result:", proposal2.verification_result);
  record("verify: mismatched domain was REJECTED", proposal2.status === "REJECTED", proposal2.status);

  await expectRejected(proposerClient, proposer, "verify_official_domain", [proposalId1], 0n, "re-verifying resolved proposal rejected");
  await expectRejected(proposerClient, proposer, "propose_official_domain", ["Nonexistent Protocol ABC", "example.com", "someorg"], 5n * ONE_GEN, "proposing for unregistered protocol rejected");

  await readOk(readClient, "list_protocols", [], "read: list_protocols (final, verify official_domains populated)");

  const passed = results.filter((r) => r.ok).length;
  console.log("");
  console.log(`=== TEST 4 SUMMARY: ${passed}/${results.length} checks passed ===`);
  for (const r of results.filter((r) => !r.ok)) console.log(`  FAILED: ${r.name} — ${r.detail}`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
});
