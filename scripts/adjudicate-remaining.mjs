#!/usr/bin/env node
/**
 * Adds real evidence to every still-OPEN/CHALLENGED claim that has none
 * (1, 2, 3, 4, 7 — claim 6 is WITHDRAWN, terminal, skipped), challenges the
 * ones not already challenged, and runs each through a real
 * submit_for_judgment (live web fetch + LLM fact-extraction + validator
 * consensus). Throttled to ~1 call per 2.5s to stay under StudioNet's
 * 30-requests/minute limit (see apps/api/src/indexer/index.ts for the
 * production incident this mirrors).
 *
 * Run from apps/web: cp ../../scripts/adjudicate-remaining.mjs scripts/ && node scripts/adjudicate-remaining.mjs
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
  const raw = await client.readContract({ address: CONTRACT_ADDRESS, functionName, args });
  return raw;
}
async function readJson(client, functionName, args) {
  return JSON.parse(await read(client, functionName, args));
}

async function call(client, account, functionName, args, value = 0n, label = "") {
  await throttle();
  const txHash = await client.writeContract({ address: CONTRACT_ADDRESS, functionName, args, value, account });
  const start = Date.now();
  const receipt = await client.waitForTransactionReceipt({ hash: txHash, status: TransactionStatus.FINALIZED, retries: 120, interval: 3000 });
  await throttle();
  const tx = await client.getTransaction({ hash: txHash });
  const outcome = findOutcome(tx);
  const secs = Math.round((Date.now() - start) / 1000);
  console.log(`  ${outcome.ok ? "✅" : "❌"} ${label || functionName} (${secs}s)${outcome.ok ? "" : " — " + outcome.message}`);
  return { txHash, ok: outcome.ok, message: outcome.message, receipt };
}

const EVIDENCE_BY_SUBJECT = {
  uniswap: [
    {
      evidence_type: "PROTOCOL_DOCUMENTATION",
      url: "https://docs.uniswap.org/contracts/v4/concepts/dynamic-fees",
      description: "Uniswap v4 core documentation confirming hooks can implement dynamic and arbitrary swap fees, set at the hook contract's discretion, separate from the LP fee tier.",
      side: "SUPPORT",
    },
    {
      evidence_type: "PROTOCOL_DOCUMENTATION",
      url: "https://docs.uniswap.org/contracts/v4/concepts/hooks",
      description: "Uniswap v4 hooks documentation describing hook permission flags (beforeSwap/afterSwap) and that hook logic, including any fee it charges, runs without a separate governance approval step per pool.",
      side: "SUPPORT",
    },
  ],
  makerdao: [
    {
      evidence_type: "PROTOCOL_DOCUMENTATION",
      url: "https://docs.makerdao.com/smart-contract-modules/shutdown/emergency-shutdown-module-detailed-documentation",
      description: "MakerDAO's detailed ESM documentation describing the fixed MKR threshold (min_MKR) that must be deposited and burned to trigger Emergency Shutdown, independent of any concurrent governance poll.",
      side: "SUPPORT",
    },
    {
      evidence_type: "GOVERNANCE_PROPOSAL",
      url: "https://docs.makerdao.com/",
      description: "MakerDAO documentation home, general reference for how governance polls and executive votes normally operate alongside the separate emergency shutdown path.",
      side: "NEUTRAL",
    },
  ],
  aave: [
    {
      evidence_type: "PROTOCOL_DOCUMENTATION",
      url: "https://docs.aave.com/developers/whats-new/isolation-mode",
      description: "Aave v3 developer documentation on Isolation Mode describing the per-asset debt ceiling and that it is enforced globally for that asset across the protocol.",
      side: "SUPPORT",
    },
    {
      evidence_type: "PROTOCOL_DOCUMENTATION",
      url: "https://docs.aave.com/risk/asset-risk/isolation-mode",
      description: "Aave risk documentation on isolation mode clarifying that the debt ceiling restricts new borrowing against that specific isolated asset once reached, not borrowing against other collateral.",
      side: "CHALLENGE",
    },
  ],
};

const CHALLENGE_ARGUMENTS = {
  uniswap:
    "The source statement is accurate on the fee cap point, but the claimant's interpretation overreaches: Uniswap v4's hook permission system requires the pool to be INITIALIZED with that specific hook contract, which itself must be deployed with an address whose leading bits match the desired permission flags — LPs and swappers choose which pool (and therefore which hook) to interact with before ever committing capital. 'No on-chain mechanism to cap it' ignores that the real safeguard is pool selection, not an in-protocol cap; framing it as 'unbounded tax' with 'no mechanism' overstates the risk versus the documentation, which frames it as a design tradeoff disclosed to integrators.",
  makerdao:
    "The claimant's math is correct about the fixed MKR threshold, but 'bypassing the normal governance poll process entirely' overstates it: triggering the ESM does not change any Vat/Cat parameters or seize collateral outside the shutdown's own deterministic unwind logic — it does not let the MKR holder set arbitrary outcomes, only trigger a fixed, pre-agreed shutdown sequence that then pays out collateral pro-rata. Calling this 'bypassing governance' conflates 'skipping a poll vote' with 'having discretionary power over the outcome', which the ESM does not grant.",
  aave:
    "Aave v3's isolation mode ceiling is per-asset but the claim overstates the blast radius: only NEW borrows against that isolated asset are blocked once the ceiling is hit — existing positions in OTHER isolated or standard collateral are entirely unaffected, so 'every other borrower' is inaccurate; it only affects borrowers of that specific isolated asset.",
};

const CLAIMS = [
  { id: "1", subject: "uniswap", needsChallenge: true },
  { id: "3", subject: "uniswap", needsChallenge: true },
  { id: "2", subject: "makerdao", needsChallenge: true },
  { id: "4", subject: "makerdao", needsChallenge: true },
  { id: "7", subject: "aave", needsChallenge: false }, // already CHALLENGED from earlier reverify run
];

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

  console.log("Evidence submitter A (claimant-side):", claimant.address);
  console.log("Evidence submitter B (challenger-side):", challenger.address);
  console.log("");

  for (const { id, subject, needsChallenge } of CLAIMS) {
    console.log(`=== Claim #${id} (${subject}) ===`);

    const evidenceItems = EVIDENCE_BY_SUBJECT[subject];
    await call(
      claimantClient,
      claimant,
      "submit_evidence",
      [id, evidenceItems[0].evidence_type, evidenceItems[0].url, evidenceItems[0].description, evidenceItems[0].side],
      0n,
      `submit_evidence #1 (${evidenceItems[0].evidence_type})`,
    );
    await call(
      challengerClient,
      challenger,
      "submit_evidence",
      [id, evidenceItems[1].evidence_type, evidenceItems[1].url, evidenceItems[1].description, evidenceItems[1].side],
      0n,
      `submit_evidence #2 (${evidenceItems[1].evidence_type})`,
    );

    if (needsChallenge) {
      await call(
        challengerClient,
        challenger,
        "submit_challenge",
        [id, CHALLENGE_ARGUMENTS[subject]],
        10n * ONE_GEN,
        "submit_challenge",
      );
    }

    console.log("  Submitting for judgment (real GenLayer LLM + validator consensus, may take 1-4 min)...");
    const judgmentResult = await call(claimantClient, claimant, "submit_for_judgment", [id], 0n, "submit_for_judgment");

    if (judgmentResult.ok) {
      const resolution = await readJson(readClient, "get_resolution", [id]);
      console.log(`  VERDICT: ${resolution.verdict} (confidence ${resolution.confidence}, payout_bps ${resolution.payout_bps})`);
      console.log(`  Reasoning: ${resolution.reasoning_summary}`);
      const claim = await readJson(readClient, "get_claim", [id]);
      console.log(`  Post-judgment status: ${claim.status}`);
    }
    console.log("");
  }

  console.log("Done. All claims visible on frontend within one indexer cycle (~15 min, or sooner once caught up).");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
});
