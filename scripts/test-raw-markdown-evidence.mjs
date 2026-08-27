#!/usr/bin/env node
/**
 * Single-claim test: does gl.nondet.web.render() succeed against a raw,
 * static GitHub markdown file (no JS rendering required), where it
 * consistently returned NO_CONTENT_RETRIEVED / NO_RELEVANT_CONTENT against
 * modern JS-rendered doc sites (docs.uniswap.org, docs.makerdao.com,
 * docs.aave.com) in every prior real test run?
 *
 * Evidence source: https://raw.githubusercontent.com/Uniswap/v4-core/main/README.md
 * (confirmed to contain real, relevant, plain-text content via direct curl).
 */
import { createClient, createAccount } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";

const CONTRACT_ADDRESS = "0xc59b5007aAA808296204abaDFbd081441c115779";
const ONE_GEN = 10n ** 18n;
const CALL_SPACING_MS = 2500;

let lastCall = 0;
async function throttle() {
  const wait = Math.max(0, lastCall + CALL_SPACING_MS - Date.now());
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
}

function decodeVoteResult(raw) {
  const base64 = typeof raw === "string" ? raw : raw?.raw;
  if (!base64) return { ok: true };
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0) return { ok: true };
  const tag = bytes[0];
  if (tag === 1) return { ok: false, message: (typeof raw === "object" && raw?.payload) || bytes.subarray(1).toString("utf8") };
  if (tag === 2) return { ok: null };
  return { ok: true };
}
function findOutcome(tx) {
  for (const v of tx?.consensus_data?.validators || []) {
    const d = decodeVoteResult(v.result);
    if (d.ok !== null) return d;
  }
  return { ok: true };
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
  await client.waitForTransactionReceipt({ hash: txHash, status: TransactionStatus.FINALIZED, retries: 120, interval: 3000 });
  await throttle();
  const tx = await client.getTransaction({ hash: txHash });
  const outcome = findOutcome(tx);
  const secs = Math.round((Date.now() - start) / 1000);
  console.log(`  ${outcome.ok ? "✅" : "❌"} ${label || functionName} (${secs}s)${outcome.ok ? "" : " — " + outcome.message}`);
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
    "create_claim",
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
      "The v4-core repository's own README, raw markdown (no JS rendering needed), describing the " +
        "singleton PoolManager architecture and the hook callback lifecycle (before/after Initialize, " +
        "AddLiquidity, RemoveLiquidity, Swap, Donate).",
      "SUPPORT",
    ],
    0n,
    "submit_evidence (raw GitHub markdown)",
  );

  await call(
    challengerClient,
    challenger,
    "submit_challenge",
    [
      claimId,
      "The singleton architecture centralizes CONTRACT STORAGE, not unscoped access — the README " +
        "describes hooks receiving callbacks tied to actions on their OWN pool (identified by a " +
        "PoolKey/PoolId), not an open door to arbitrary cross-pool state. 'Sufficiently privileged " +
        "hook could read cross-pool state' is not supported by anything in the README, which never " +
        "describes a permission model granting hooks access beyond their own pool's callback context.",
    ],
    10n * ONE_GEN,
    "submit_challenge",
  );

  console.log("Submitting for judgment (real GenLayer LLM + validator consensus, may take 1-4 min)...");
  const judgmentResult = await call(claimantClient, claimant, "submit_for_judgment", [claimId], 0n, "submit_for_judgment");

  if (judgmentResult.ok) {
    const evidence = await readJson(readClient, "list_evidence_for_claim", [claimId]);
    console.log("");
    console.log("Evidence Manifest after judgment:");
    for (const item of evidence) {
      console.log(`  - ${item.url}`);
      console.log(`    retrieved_at: ${item.retrieved_at}, content_hash: ${item.content_hash}, cited: ${item.cited_in_verdict}`);
    }

    const resolution = await readJson(readClient, "get_resolution", [claimId]);
    console.log("");
    console.log("VERDICT:", resolution.verdict, "| confidence:", resolution.confidence, "| payout_bps:", resolution.payout_bps);
    console.log("Reasoning:", resolution.reasoning_summary);

    const claim = await readJson(readClient, "get_claim", [claimId]);
    console.log("Post-judgment status:", claim.status);
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
});
