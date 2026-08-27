#!/usr/bin/env node
/**
 * Retries submit_for_judgment on claim #8, using the CORRECTED outcome
 * detection (vote-tally-aware — see apps/web/lib/contract.ts's
 * findVoteOutcome for the production version of this fix). submit_for_judgment
 * has no caller restriction in the contract, so any funded account can call it.
 */
import { createClient, createAccount } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";

const CONTRACT_ADDRESS = "0xc59b5007aAA808296204abaDFbd081441c115779";
const CLAIM_ID = "8";

function findVoteOutcome(tx) {
  const votes = tx?.consensus_data?.votes ?? {};
  let agree = 0,
    disagree = 0;
  for (const v of Object.values(votes)) {
    if (v === "agree") agree++;
    else if (v === "disagree") disagree++;
  }
  if (disagree > 0 && disagree >= agree) {
    return { ok: false, message: `Validators disagreed (${disagree} disagree vs ${agree} agree) — no state change applied.` };
  }
  for (const v of tx?.consensus_data?.validators || []) {
    const base64 = typeof v.result === "string" ? v.result : v.result?.raw;
    if (!base64) continue;
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length === 0) continue;
    const tag = bytes[0];
    if (tag === 2) continue; // idle
    if (tag === 1) return { ok: false, message: bytes.subarray(1).toString("utf8") };
    return { ok: true };
  }
  return { ok: true };
}

async function main() {
  const readClient = createClient({ chain: studionet });
  const account = createAccount();
  const client = createClient({ chain: studionet, account });
  await client.request({ method: "sim_fundAccount", params: [account.address, 1000] });
  console.log("Caller:", account.address);

  const claimBefore = JSON.parse(await readClient.readContract({ address: CONTRACT_ADDRESS, functionName: "get_claim", args: [CLAIM_ID] }));
  console.log("Claim #8 status before retry:", claimBefore.status);
  if (claimBefore.status !== "CHALLENGED") {
    console.log("Claim is not in CHALLENGED status — cannot submit for judgment. Aborting.");
    process.exit(1);
  }

  console.log("Submitting for judgment (real GenLayer LLM + validator consensus, may take 1-4 min)...");
  const txHash = await client.writeContract({ address: CONTRACT_ADDRESS, functionName: "submit_for_judgment", args: [CLAIM_ID], value: 0n, account });
  const start = Date.now();
  await client.waitForTransactionReceipt({ hash: txHash, status: TransactionStatus.FINALIZED, retries: 120, interval: 3000 });
  const tx = await client.getTransaction({ hash: txHash });
  const outcome = findVoteOutcome(tx);
  const secs = Math.round((Date.now() - start) / 1000);

  console.log(`\n${outcome.ok ? "✅ SUCCESS" : "❌ FAILED"} (${secs}s)${outcome.ok ? "" : " — " + outcome.message}`);
  if (tx?.consensus_data?.votes) {
    console.log("Vote tally:", JSON.stringify(tx.consensus_data.votes));
  }

  const claimAfter = JSON.parse(await readClient.readContract({ address: CONTRACT_ADDRESS, functionName: "get_claim", args: [CLAIM_ID] }));
  console.log("Claim #8 status after retry:", claimAfter.status);

  if (claimAfter.status !== "CHALLENGED") {
    try {
      const resolution = JSON.parse(await readClient.readContract({ address: CONTRACT_ADDRESS, functionName: "get_resolution", args: [CLAIM_ID] }));
      console.log("\nVERDICT:", resolution.verdict, "| confidence:", resolution.confidence, "| payout_bps:", resolution.payout_bps);
      console.log("Reasoning:", resolution.reasoning_summary);
      const evidence = JSON.parse(await readClient.readContract({ address: CONTRACT_ADDRESS, functionName: "list_evidence_for_claim", args: [CLAIM_ID] }));
      for (const item of evidence) {
        console.log(`Evidence: ${item.url} — retrieved_at: ${item.retrieved_at}, content_hash: ${item.content_hash}, cited: ${item.cited_in_verdict}`);
      }
    } catch (e) {
      console.log("get_resolution error:", e.message || e);
    }
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
});
