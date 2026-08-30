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
async function call(client, account, functionName, args, value, label) {
  await throttle();
  const txHash = await client.writeContract({ address: CONTRACT_ADDRESS, functionName, args, value: value ?? 0n, account });
  const start = Date.now();
  await client.waitForTransactionReceipt({ hash: txHash, status: TransactionStatus.FINALIZED, retries: 150, interval: 3000 });
  await throttle();
  const tx = await client.getTransaction({ hash: txHash });
  const outcome = findVoteOutcome(tx);
  const secs = Math.round((Date.now() - start) / 1000);
  console.log(`  ${outcome.ok ? "✅" : "❌"} ${label} (${secs}s)${outcome.ok ? "" : " — " + outcome.message}`);
  if (outcome.votes) console.log("     votes:", JSON.stringify(outcome.votes));
  return { ok: outcome.ok, message: outcome.message };
}
async function readJson(client, functionName, args) {
  await throttle();
  return JSON.parse(await client.readContract({ address: CONTRACT_ADDRESS, functionName, args }));
}
async function expectRejected(client, account, functionName, args, value, label) {
  await throttle();
  try {
    const txHash = await client.writeContract({ address: CONTRACT_ADDRESS, functionName, args, value: value ?? 0n, account });
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
  const proposer = createAccount();
  const proposerClient = createClient({ chain: studionet, account: proposer });
  await proposerClient.request({ method: "sim_fundAccount", params: [proposer.address, 100] });
  console.log("Proposer:", proposer.address);

  // Register the protocol first (propose_official_domain requires it to
  // already exist — register_protocol is permissionless).
  await call(proposerClient, proposer, "register_protocol", ["Uniswap v4", "DeFi / AMM"], 0n, "register_protocol(Uniswap v4)");

  console.log("");
  console.log("--- Real case: uniswap.org IS the real Uniswap GitHub org's website ---");
  await call(
    proposerClient, proposer, "propose_official_domain",
    ["Uniswap v4", "uniswap.org", "Uniswap"],
    5n * ONE_GEN, "propose_official_domain(Uniswap v4, uniswap.org, Uniswap)",
  );
  const proposalId1 = String(await readJson(readClient, "get_domain_proposal_count", []));
  console.log("  Proposal id:", proposalId1);

  await call(proposerClient, proposer, "verify_official_domain", [proposalId1], 0n, "verify_official_domain(1) — THE consensus check");
  const proposal1 = await readJson(readClient, "get_domain_proposal", [proposalId1]);
  console.log("  Proposal 1 status:", proposal1.status, "| verification_result:", proposal1.verification_result);

  if (proposal1.status === "VERIFIED") {
    const protocols = await readJson(readClient, "list_protocols", []);
    console.log("  Uniswap v4 official_domains:", protocols["Uniswap v4"]?.official_domains);
  }

  console.log("");
  console.log("--- Negative control: a mismatched domain must NOT verify ---");
  await call(
    proposerClient, proposer, "propose_official_domain",
    ["Uniswap v4", "totally-unrelated-website.example", "Uniswap"],
    5n * ONE_GEN, "propose_official_domain(Uniswap v4, totally-unrelated-website.example, Uniswap)",
  );
  const proposalId2 = String(await readJson(readClient, "get_domain_proposal_count", []));
  console.log("  Proposal id:", proposalId2);
  await call(proposerClient, proposer, "verify_official_domain", [proposalId2], 0n, "verify_official_domain(2) — should REJECT");
  const proposal2 = await readJson(readClient, "get_domain_proposal", [proposalId2]);
  console.log("  Proposal 2 status:", proposal2.status, "| verification_result:", proposal2.verification_result);

  console.log("");
  console.log("--- Access-control checks ---");
  await expectRejected(proposerClient, proposer, "verify_official_domain", [proposalId1], 0n, "re-verifying an already-resolved proposal rejected");
  await expectRejected(proposerClient, proposer, "propose_official_domain", ["Unknown Protocol XYZ", "example.com", "someorg"], 5n * ONE_GEN, "proposing a domain for an unregistered protocol rejected");
  await expectRejected(proposerClient, proposer, "propose_official_domain", ["Uniswap v4", "uniswap.org", "Uniswap"], 1n * ONE_GEN, "proposal with bond below minimum rejected");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
});
