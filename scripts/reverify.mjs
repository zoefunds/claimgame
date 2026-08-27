#!/usr/bin/env node
/**
 * Focused re-verification script — companion to test-contract.mjs.
 * Confirms access-control rejections, bounty create/contribute, and
 * challenge success/rejection paths using the byte-tag vote-result
 * decoder (see contract.ts's mapStatusName/decodeVoteResult for the
 * production version of this logic). Does NOT call submit_for_judgment
 * (that's a real, costly LLM+consensus call — already validated once in
 * test-contract.mjs; no need to re-pay for it on every re-run).
 *
 * Run from apps/web (needs its node_modules for genlayer-js):
 *   cp scripts/reverify.mjs apps/web/scripts/reverify.mjs && cd apps/web && node scripts/reverify.mjs
 */
import { createClient, createAccount } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";

const CONTRACT_ADDRESS = "0xc59b5007aAA808296204abaDFbd081441c115779";
const ONE_GEN = 10n ** 18n;

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
  if (tag === 2) return { tag, ok: null };
  return { tag, ok: true };
}
function findOutcome(tx) {
  for (const v of tx?.consensus_data?.validators || []) {
    const d = decodeVoteResult(v.result);
    if (d.ok !== null) return d;
  }
  return { tag: null, ok: true };
}
async function call(client, account, functionName, args, value = 0n) {
  const txHash = await client.writeContract({ address: CONTRACT_ADDRESS, functionName, args, value, account });
  await client.waitForTransactionReceipt({ hash: txHash, status: TransactionStatus.FINALIZED, retries: 60, interval: 3000 });
  const tx = await client.getTransaction({ hash: txHash });
  const outcome = findOutcome(tx);
  return { txHash, ok: outcome.ok, message: outcome.message };
}

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? "✅ PASS" : "❌ FAIL"}  ${name}${detail ? " — " + detail : ""}`);
}

async function main() {
  const readClient = createClient({ chain: studionet });
  const a = createAccount();
  const client = createClient({ chain: studionet, account: a });
  await client.request({ method: "sim_fundAccount", params: [a.address, 5000] });
  console.log("Test account:", a.address);

  const seasonResult = await call(client, a, "create_season", ["ReverifySeason", "2026-01-01T00:00:00Z", "2026-04-01T00:00:00Z"]);
  record("create_season rejected for non-owner", !seasonResult.ok, seasonResult.message);

  const transferResult = await call(client, a, "transfer_ownership", [a.address]);
  record("transfer_ownership rejected for non-owner", !transferResult.ok, transferResult.message);

  const b = createAccount();
  const bClient = createClient({ chain: studionet, account: b });
  await bClient.request({ method: "sim_fundAccount", params: [b.address, 5000] });

  const createResult = await call(
    client,
    a,
    "create_claim",
    [
      "Aave v3",
      "Protocol Claims",
      "Isolation mode debt ceiling enforcement",
      "Aave v3's isolation mode restricts a collateral asset to a fixed debt ceiling denominated " +
        "in the borrowed stablecoin, enforced at the protocol level per the Aave v3 technical paper.",
      "Because the ceiling is a global per-asset parameter, once any borrower across the entire " +
        "protocol pushes total isolated debt for that asset to the ceiling, every other borrower " +
        "using that same isolated collateral is blocked from borrowing more, even if their own " +
        "individual position is nowhere near liquidation.",
      "AMBIGUOUS",
      21600,
    ],
    10n * ONE_GEN,
  );
  record("create_claim (Aave v3 isolation-mode dispute)", createResult.ok, createResult.message);

  const claimCountRaw = await readClient.readContract({ address: CONTRACT_ADDRESS, functionName: "get_claim_count", args: [] });
  const claimId = String(claimCountRaw);
  console.log("Using claim id:", claimId);

  const bountyResult = await call(client, a, "create_bounty", [claimId, 2000, 3000, 5000], 200n * ONE_GEN);
  record("create_bounty (200 GEN)", bountyResult.ok, bountyResult.message);

  const contributeResult = await call(bClient, b, "contribute_to_bounty", [claimId], 50n * ONE_GEN);
  record("contribute_to_bounty (+50 GEN)", contributeResult.ok, contributeResult.message);

  const bountyRaw = await readClient.readContract({ address: CONTRACT_ADDRESS, functionName: "get_bounty", args: [claimId] });
  const bounty = JSON.parse(bountyRaw);
  record("get_bounty total_deposited == 250 GEN", bounty.total_deposited === (250n * ONE_GEN).toString(), bountyRaw);

  const challengeResult = await call(
    bClient,
    b,
    "submit_challenge",
    [
      claimId,
      "Aave v3's isolation mode ceiling is per-asset but the claim overstates the blast radius: " +
        "only NEW borrows against that isolated asset are blocked once the ceiling is hit, existing " +
        "positions in OTHER isolated or standard collateral are entirely unaffected, so 'every other " +
        "borrower' is inaccurate — it only affects borrowers of that specific isolated asset.",
    ],
    10n * ONE_GEN,
  );
  record("submit_challenge (real counter-argument, 10 GEN stake)", challengeResult.ok, challengeResult.message);

  const challengeRaw = await readClient.readContract({ address: CONTRACT_ADDRESS, functionName: "get_challenge", args: [claimId] });
  const challenge = JSON.parse(challengeRaw);
  record(
    "get_challenge shows challenger + correct stake",
    challenge.challenger.toLowerCase() === b.address.toLowerCase() && challenge.challenge_stake_deposited === (10n * ONE_GEN).toString(),
    challengeRaw,
  );

  const claimRaw = await readClient.readContract({ address: CONTRACT_ADDRESS, functionName: "get_claim", args: [claimId] });
  const claim = JSON.parse(claimRaw);
  record("get_claim status == CHALLENGED", claim.status === "CHALLENGED", claimRaw);

  const evidenceUnknownResult = await call(client, a, "submit_evidence", ["999999", "URL", "https://example.org", "test", "SUPPORT"]);
  record("submit_evidence rejected on unknown claim id", !evidenceUnknownResult.ok, evidenceUnknownResult.message);

  const challengeAgainResult = await call(bClient, b, "submit_challenge", [claimId, "second challenge should be rejected, claim already CHALLENGED not OPEN"], 10n * ONE_GEN);
  record("submit_challenge rejected on an already-CHALLENGED claim", !challengeAgainResult.ok, challengeAgainResult.message);

  console.log("");
  const passed = results.filter((r) => r.pass).length;
  console.log(`${passed}/${results.length} passed`);
  console.log("Claim id created:", claimId, "— visible on frontend within one indexer cycle");
  process.exitCode = passed === results.length ? 0 : 1;
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
});
