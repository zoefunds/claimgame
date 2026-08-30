#!/usr/bin/env node
/**
 * Judgment-reliability matrix (audit remaining-blocker #1): a recorded,
 * published set of real judgment attempts against varied real disputes,
 * to build an actual sample size beyond "it worked once." Each case is
 * judgment-only (create_claim -> submit_evidence -> submit_challenge ->
 * submit_for_judgment) using confirmed-live, real evidence URLs (verified
 * via curl immediately before writing this script — aave-v3-core and
 * makerdao/mcd-cat were found dead/moved and excluded).
 *
 * Run: node scripts/judgment-reliability-matrix.mjs
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
  return { ok: outcome.ok, message: outcome.message, secs };
}
async function readJson(client, functionName, args) {
  await throttle();
  return JSON.parse(await client.readContract({ address: CONTRACT_ADDRESS, functionName, args }));
}

const CASES = [
  {
    protocol: "Uniswap v4", subject: "PoolManager singleton architecture (matrix case 1)",
    statement: "Per the Uniswap v4-core README, v4-core uses a singleton-style architecture where all pool state is managed in the PoolManager.sol contract.",
    interpretation: "All v4 pools share one deployed PoolManager contract instance rather than each pool having its own separate contract address.",
    challenge: "This is wrong because Uniswap v4 has never been deployed to any network, so there is no real architecture to evaluate.",
    url: "https://raw.githubusercontent.com/Uniswap/v4-core/main/README.md",
    difficulty: "EASY",
  },
  {
    protocol: "OpenZeppelin Contracts", subject: "OpenZeppelin provides audited reusable contract building blocks (matrix case 2)",
    statement: "Per OpenZeppelin's own README, the library provides implementations of standards like ERC20 and ERC721, along with Solidity components to build custom contracts and decentralized applications.",
    interpretation: "OpenZeppelin Contracts is a reusable library of standard implementations meant to be imported into other projects' contracts, not a standalone deployed application.",
    challenge: "This is wrong because OpenZeppelin only publishes documentation and has no actual Solidity code in the repository.",
    url: "https://raw.githubusercontent.com/OpenZeppelin/openzeppelin-contracts/master/README.md",
    difficulty: "EASY",
  },
  {
    protocol: "Compound Protocol", subject: "Compound protocol-core is a Solidity smart contract system (matrix case 3)",
    statement: "Per the compound-protocol repository's README, this repo contains the Solidity source code for the Compound Protocol's smart contracts on Ethereum, along with a testing/build pipeline (CircleCI, codecov).",
    interpretation: "Compound Protocol's core logic is implemented and tested as Solidity smart contracts in this repository, not merely described in prose documentation.",
    challenge: "This is wrong because Compound Protocol is purely a whitepaper concept with no actual contract code ever written.",
    url: "https://raw.githubusercontent.com/compound-finance/compound-protocol/master/README.md",
    difficulty: "EASY",
  },
  {
    protocol: "Curve Finance", subject: "Curve pools are Vyper contracts for stablecoin trading (matrix case 4)",
    statement: "Per the curve-contract README, Curve is an exchange liquidity pool on Ethereum designed for extremely efficient stablecoin trading and low risk, supplemental fee income for liquidity providers, implemented in Vyper contracts.",
    interpretation: "Curve's exchange pools are written in Vyper (not Solidity) and are specifically optimized for stablecoin (low-slippage, similarly-priced asset) trading rather than general-purpose volatile-asset swaps.",
    challenge: "This is wrong because Curve pools are written in Solidity like every other Ethereum DeFi protocol, not a different language.",
    url: "https://raw.githubusercontent.com/curvefi/curve-contract/master/README.md",
    difficulty: "EASY",
  },
  {
    protocol: "Lido", subject: "Lido DAO governs the Lido liquid staking protocol (matrix case 5)",
    statement: "Per the lido-dao repository's README, this repo contains the Lido DAO smart contracts, released under an open-source license and versioned (e.g. v3.0.2 shown in the README badge).",
    interpretation: "Lido's staking protocol contracts are versioned, licensed open-source software maintained in this specific repository, not an unversioned or closed-source system.",
    challenge: "This is wrong because Lido has no DAO governance structure at all and is fully centralized with no public code.",
    url: "https://raw.githubusercontent.com/lidofinance/lido-dao/master/README.md",
    difficulty: "EASY",
  },
  {
    protocol: "Chainlink", subject: "Chainlink is a decentralized oracle network project (matrix case 6)",
    statement: "Per the smartcontractkit/chainlink repository's own README (linking to chain.link and showing a versioned release tag), Chainlink is maintained as an actively-released, tagged software project.",
    interpretation: "Chainlink ships versioned releases from this actively maintained repository, meaning the protocol's implementation is a continuously developed codebase, not a one-time static deployment.",
    challenge: "This is wrong because Chainlink stopped all development years ago and this repository is abandoned with no releases.",
    url: "https://raw.githubusercontent.com/smartcontractkit/chainlink/develop/README.md",
    difficulty: "EASY",
  },
];

async function main() {
  const readClient = createClient({ chain: studionet });
  const results = [];

  for (const [i, c] of CASES.entries()) {
    console.log("");
    console.log(`--- Matrix case ${i + 1}/${CASES.length}: ${c.protocol} ---`);
    const claimant = createAccount();
    const claimantClient = createClient({ chain: studionet, account: claimant });
    await claimantClient.request({ method: "sim_fundAccount", params: [claimant.address, 100] });
    const challenger = createAccount();
    const challengerClient = createClient({ chain: studionet, account: challenger });
    await challengerClient.request({ method: "sim_fundAccount", params: [challenger.address, 100] });

    const createResult = await call(
      claimantClient, claimant, "create_claim",
      [c.protocol, "Protocol Claims", c.subject, c.statement, c.interpretation, c.difficulty, 21600],
      10n * ONE_GEN, `create_claim (${c.protocol})`,
    );
    if (!createResult.ok) { results.push({ case: i + 1, protocol: c.protocol, stage: "create_claim", ok: false, message: createResult.message }); continue; }

    const claimId = String(await readJson(readClient, "get_claim_count", []));

    const evResult = await call(
      claimantClient, claimant, "submit_evidence",
      [claimId, "PROTOCOL_DOCUMENTATION", c.url, `${c.protocol}'s own repository README, directly on point.`, "SUPPORT"],
      0n, `submit_evidence`,
    );
    if (!evResult.ok) { results.push({ case: i + 1, protocol: c.protocol, stage: "submit_evidence", ok: false, message: evResult.message }); continue; }

    const chResult = await call(challengerClient, challenger, "submit_challenge", [claimId, c.challenge], 10n * ONE_GEN, "submit_challenge");
    if (!chResult.ok) { results.push({ case: i + 1, protocol: c.protocol, stage: "submit_challenge", ok: false, message: chResult.message }); continue; }

    const judgResult = await call(claimantClient, claimant, "submit_for_judgment", [claimId], 0n, "submit_for_judgment (THE matrix data point)");
    let verdictInfo = "";
    if (judgResult.ok) {
      const claim = await readJson(readClient, "get_claim", [claimId]);
      const resolution = await readClient.readContract({ address: CONTRACT_ADDRESS, functionName: "get_resolution", args: [claimId] }).catch(() => null);
      verdictInfo = `status=${claim.status}` + (resolution ? `, ${JSON.parse(resolution).verdict}/${JSON.parse(resolution).confidence}` : "");
      console.log("    ", verdictInfo);
    }
    results.push({ case: i + 1, protocol: c.protocol, claimId, stage: "submit_for_judgment", ok: judgResult.ok, message: judgResult.message, secs: judgResult.secs, verdictInfo });
  }

  console.log("");
  console.log("=== JUDGMENT RELIABILITY MATRIX RESULTS ===");
  const judgmentAttempts = results.filter((r) => r.stage === "submit_for_judgment");
  const consensusReached = judgmentAttempts.filter((r) => r.ok).length;
  console.log(`${consensusReached}/${judgmentAttempts.length} judgment calls reached validator consensus on first attempt.`);
  for (const r of results) {
    console.log(`  Case ${r.case} (${r.protocol}) [claim ${r.claimId ?? "n/a"}]: ${r.stage} ${r.ok ? "✅ OK" : "❌ " + r.message}${r.verdictInfo ? " — " + r.verdictInfo : ""}`);
  }
  process.exitCode = judgmentAttempts.some((r) => !r.ok) ? 0 : 0; // informational, not pass/fail
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
});
