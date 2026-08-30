#!/usr/bin/env node
/**
 * Second batch of the judgment reliability matrix (audit remaining-blocker
 * #1) — grows the sample toward the 20-50 case target. Same methodology as
 * scripts/judgment-reliability-matrix.mjs: real, curl-verified evidence
 * URLs, real claim text, judgment-only lifecycle.
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
    protocol: "Go Ethereum", subject: "Geth is the Go implementation of Ethereum's execution layer (matrix case 7)",
    statement: "Per the go-ethereum README, this project is a Golang execution layer implementation of the Ethereum protocol.",
    interpretation: "Geth implements only the execution layer of Ethereum (transaction processing, EVM), not the consensus layer, meaning it must be paired with a separate consensus client in a post-Merge Ethereum node setup.",
    challenge: "This is wrong because go-ethereum is written in Rust, not Go, despite what the project name suggests.",
    url: "https://raw.githubusercontent.com/ethereum/go-ethereum/master/README.md",
  },
  {
    protocol: "Foundry", subject: "Foundry is a smart contract development toolchain (matrix case 8)",
    statement: "Per the foundry-rs/foundry README, Foundry is a blazing fast, portable, and modular toolkit for Ethereum application development, distributed as multiple components with CI badges shown in the README.",
    interpretation: "Foundry ships as a toolkit made of multiple distinct components (implying tools like forge/cast/anvil work together but are separable), and is actively tested via continuous integration as shown by the README's CI badge.",
    challenge: "This is wrong because Foundry is a single monolithic binary with no separate components and has never had automated testing.",
    url: "https://raw.githubusercontent.com/foundry-rs/foundry/master/README.md",
  },
  {
    protocol: "Safe (Gnosis Safe)", subject: "Safe Smart Account is published as an npm package (matrix case 9)",
    statement: "Per the safe-global/safe-smart-account README, this project is versioned and published as the npm package @safe-global/safe-smart-account, shown via an npm version badge.",
    interpretation: "Safe's smart contract source is distributed through the npm package registry with semantic versioning, meaning other projects can install a specific pinned version of the contracts as a dependency rather than copying source files manually.",
    challenge: "This is wrong because Safe has never been published to any package registry and can only be used by manually copying Solidity files.",
    url: "https://raw.githubusercontent.com/safe-global/safe-smart-account/main/README.md",
  },
  {
    protocol: "IPFS Kubo", subject: "Kubo is an implementation of the IPFS protocol (matrix case 10)",
    statement: "Per the ipfs/kubo README (with its logo and project links), Kubo is the go-to implementation of IPFS.",
    interpretation: "Kubo is specifically an IMPLEMENTATION of the IPFS protocol (one of potentially several), not the protocol specification itself — meaning IPFS as a protocol is implementation-agnostic even though Kubo is presented as the primary reference implementation.",
    challenge: "This is wrong because IPFS and Kubo are the exact same thing with no distinction between protocol and implementation.",
    url: "https://raw.githubusercontent.com/ipfs/kubo/master/README.md",
  },
  {
    protocol: "Balancer V2", subject: "Balancer V2 is organized as a monorepo (matrix case 11)",
    statement: "Per the balancer/balancer-v2-monorepo README, this repository is explicitly named and structured as a monorepo, with a Docs badge linking to docs.balancer.fi and a CI Status badge.",
    interpretation: "Balancer V2's various packages/components are maintained together in a single repository (a monorepo pattern) rather than as separate independently-versioned repositories, and the project has both external documentation and continuous integration.",
    challenge: "This is wrong because Balancer V2 has no CI pipeline at all and consists of a single unstructured folder of files, not a monorepo.",
    url: "https://raw.githubusercontent.com/balancer/balancer-v2-monorepo/master/README.md",
  },
  {
    protocol: "The Graph", subject: "graph-node indexes blockchain data for GraphQL queries (matrix case 12)",
    statement: "Per the graphprotocol/graph-node README, this project has an active CI build status badge linking to its GitHub Actions workflow.",
    interpretation: "graph-node's build health is continuously verified through automated GitHub Actions CI, meaning changes to the codebase are checked by an automated pipeline before being considered stable, not just manually reviewed.",
    challenge: "This is wrong because The Graph protocol has no automated testing infrastructure of any kind for graph-node.",
    url: "https://raw.githubusercontent.com/graphprotocol/graph-node/master/README.md",
  },
];

async function main() {
  const readClient = createClient({ chain: studionet });
  const results = [];

  for (const [i, c] of CASES.entries()) {
    console.log("");
    console.log(`--- Matrix case ${i + 7}/12: ${c.protocol} ---`);
    const claimant = createAccount();
    const claimantClient = createClient({ chain: studionet, account: claimant });
    await claimantClient.request({ method: "sim_fundAccount", params: [claimant.address, 100] });
    const challenger = createAccount();
    const challengerClient = createClient({ chain: studionet, account: challenger });
    await challengerClient.request({ method: "sim_fundAccount", params: [challenger.address, 100] });

    const createResult = await call(
      claimantClient, claimant, "create_claim",
      [c.protocol, "Protocol Claims", c.subject, c.statement, c.interpretation, "EASY", 21600],
      10n * ONE_GEN, `create_claim (${c.protocol})`,
    );
    if (!createResult.ok) { results.push({ case: i + 7, protocol: c.protocol, stage: "create_claim", ok: false, message: createResult.message }); continue; }

    const claimId = String(await readJson(readClient, "get_claim_count", []));

    const evResult = await call(
      claimantClient, claimant, "submit_evidence",
      [claimId, "PROTOCOL_DOCUMENTATION", c.url, `${c.protocol}'s own repository README, directly on point.`, "SUPPORT"],
      0n, "submit_evidence",
    );
    if (!evResult.ok) { results.push({ case: i + 7, protocol: c.protocol, stage: "submit_evidence", ok: false, message: evResult.message }); continue; }

    const chResult = await call(challengerClient, challenger, "submit_challenge", [claimId, c.challenge], 10n * ONE_GEN, "submit_challenge");
    if (!chResult.ok) { results.push({ case: i + 7, protocol: c.protocol, stage: "submit_challenge", ok: false, message: chResult.message }); continue; }

    const judgResult = await call(claimantClient, claimant, "submit_for_judgment", [claimId], 0n, "submit_for_judgment (THE matrix data point)");
    let verdictInfo = "";
    if (judgResult.ok) {
      const claim = await readJson(readClient, "get_claim", [claimId]);
      const resolution = await readClient.readContract({ address: CONTRACT_ADDRESS, functionName: "get_resolution", args: [claimId] }).catch(() => null);
      verdictInfo = `status=${claim.status}` + (resolution ? `, ${JSON.parse(resolution).verdict}/${JSON.parse(resolution).confidence}` : "");
      console.log("    ", verdictInfo);
    }
    results.push({ case: i + 7, protocol: c.protocol, claimId, stage: "submit_for_judgment", ok: judgResult.ok, message: judgResult.message, verdictInfo });
  }

  console.log("");
  console.log("=== MATRIX BATCH 2 RESULTS ===");
  const judgmentAttempts = results.filter((r) => r.stage === "submit_for_judgment");
  const consensusReached = judgmentAttempts.filter((r) => r.ok).length;
  console.log(`${consensusReached}/${judgmentAttempts.length} judgment calls reached validator consensus on first attempt (this batch).`);
  for (const r of results) {
    console.log(`  Case ${r.case} (${r.protocol}) [claim ${r.claimId ?? "n/a"}]: ${r.stage} ${r.ok ? "✅ OK" : "❌ " + r.message}${r.verdictInfo ? " — " + r.verdictInfo : ""}`);
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
});
