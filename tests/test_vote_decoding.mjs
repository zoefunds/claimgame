#!/usr/bin/env node
/**
 * Deterministic tests for the frontend's transaction-outcome detection
 * (apps/web/lib/contract.ts's findVoteOutcome/decodeVoteResult) — the
 * exact logic that was WRONG in production for real: it silently reported
 * a majority-"disagree" consensus failure as a success (see docs/genlayer.md's
 * v0.3.1 incident writeup). This is a plain assertion script, zero
 * dependencies, run with `node tests/test_vote_decoding.mjs` — not
 * imported from lib/contract.ts directly (that file is a "use client"
 * Next.js module with framework-coupled imports), so this is a duplicate
 * mirror like the Python tests: keep both in sync when the real
 * implementation changes.
 */

function decodeVoteResult(raw) {
  const base64 = typeof raw === "string" ? raw : raw?.raw;
  if (!base64) return { ok: true };
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0) return { ok: true };
  const tag = bytes[0];
  if (tag === 1) {
    const decoded = bytes.subarray(1).toString("utf8");
    const payloadHint = typeof raw === "object" ? raw?.payload : undefined;
    return { ok: false, message: payloadHint || decoded };
  }
  if (tag === 2) return { ok: null };
  return { ok: true };
}

function findVoteOutcome(tx) {
  const votes = tx?.consensus_data?.votes ?? {};
  const tally = Object.values(votes).reduce(
    (acc, v) => {
      if (v === "agree") acc.agree++;
      else if (v === "disagree") acc.disagree++;
      return acc;
    },
    { agree: 0, disagree: 0 },
  );
  if (tally.disagree > 0 && tally.disagree >= tally.agree) {
    return { ok: false, message: "Validators could not reach consensus on this call" };
  }
  const validators = tx?.consensus_data?.validators ?? [];
  for (const v of validators) {
    const outcome = decodeVoteResult(v.result);
    if (outcome.ok !== null) return outcome;
  }
  return { ok: true };
}

function b64(tagByte, text = "") {
  const bytes = Buffer.concat([Buffer.from([tagByte]), Buffer.from(text, "utf8")]);
  return bytes.toString("base64");
}

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}`);
  }
}

console.log("decodeVoteResult");
assert(decodeVoteResult(b64(0)).ok === true, "tag 0 => success");
assert(decodeVoteResult(b64(1, "Only owner")).ok === false, "tag 1 => rollback");
assert(decodeVoteResult(b64(1, "Only owner")).message === "Only owner", "tag 1 carries the UserError message");
assert(decodeVoteResult(b64(2)).ok === null, "tag 2 => idle (skip, not a real result)");
assert(decodeVoteResult(undefined).ok === true, "no result => default to true (nothing to report)");
assert(decodeVoteResult("").ok === true, "empty string => default to true");

console.log("");
console.log("findVoteOutcome — the incident scenario (audit finding #6)");
{
  // THE actual production bug: majority disagree, but every individual
  // validator's raw result byte decodes as ambiguous/ok — the old code
  // (byte-tag only, no vote-tally check) reported this as SUCCESS. This
  // must now report failure.
  const incidentTx = {
    consensus_data: {
      votes: {
        v1: "idle",
        v2: "idle",
        v3: "disagree",
        v4: "disagree",
        v5: "disagree",
      },
      validators: [
        { vote: "idle", result: b64(2) },
        { vote: "disagree", result: "" }, // empty/unparseable — old decoder defaulted to ok:true
        { vote: "idle", result: b64(2) },
        { vote: "disagree", result: "" },
      ],
    },
  };
  const outcome = findVoteOutcome(incidentTx);
  assert(outcome.ok === false, "majority-disagree consensus failure is correctly detected as NOT success");
}

console.log("");
console.log("findVoteOutcome — normal cases");
{
  const successTx = {
    consensus_data: {
      votes: { v1: "agree", v2: "agree", v3: "agree", v4: "agree", v5: "agree" },
      validators: [{ vote: "agree", result: b64(0) }],
    },
  };
  assert(findVoteOutcome(successTx).ok === true, "unanimous agree => success");
}
{
  const rollbackTx = {
    consensus_data: {
      votes: { v1: "agree", v2: "agree", v3: "agree" },
      validators: [{ vote: "agree", result: b64(1, "Challenge stake below required minimum") }],
    },
  };
  const outcome = findVoteOutcome(rollbackTx);
  assert(outcome.ok === false, "agreed-upon UserError rollback is still reported as failure");
  assert(outcome.message.includes("stake"), "rollback message is preserved");
}
{
  const tiedTx = {
    consensus_data: {
      votes: { v1: "agree", v2: "agree", v3: "disagree", v4: "disagree" },
      validators: [],
    },
  };
  assert(findVoteOutcome(tiedTx).ok === false, "a tie (disagree >= agree) is treated as failure, not optimistically as success");
}
{
  const noVotesTx = { consensus_data: { votes: {}, validators: [{ vote: "agree", result: b64(0) }] } };
  assert(findVoteOutcome(noVotesTx).ok === true, "no votes recorded falls through to per-validator result decoding");
}

console.log("");
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
