# CLAIMGAME — Evidence Packet

A single page pointing at reproducible proof for every claim this project makes. Nothing here is asserted without a command, file, or address a reader can check independently. If any item below no longer matches what you observe, trust what you observe — see the "point-in-time snapshot" notes throughout the docs.

## Deployment

- **Contract address:** `0x4F3789881344cB7a5176b19eEADBAc3586Bb2EA6` (v0.3.11, GenLayer StudioNet)
- **Live app:** https://claim-game.vercel.app
- **API health check:** `curl -s https://claimgame-api.fly.dev/healthz` — returns the currently-live contract address; cross-check it against the address above before trusting anything else here
- **Source of the deployed contract:** [`contracts/claimgame/contract.py`](../contracts/claimgame/contract.py) (2,128 lines, 43 public methods — 22 view / 21 write; verify with `wc -l` and `genvm-lint check contracts/claimgame/contract.py --json`)

## Test commands

```bash
pnpm run verify          # everything below, in one command (mirrors CI exactly)
```

Or individually:

```bash
python3 -m unittest discover -s tests -v   # 65 tests: contract pure-logic + adversarial inputs
node tests/test_vote_decoding.mjs          # 12 tests: frontend vote-tally decoding
node tests/test_cid.mjs                    # 3 tests: CIDv1 content-addressing
python3 -m py_compile contracts/claimgame/contract.py
genvm-lint check contracts/claimgame/contract.py --json
node scripts/product-test-1-full-lifecycle.mjs   # live, on-chain, not mocked — see below
```

## Why GenLayer is load-bearing here

The strongest evidence is that the backend structurally cannot do the job the contract does:

- The indexer (`apps/indexer`) only ever calls read methods against the contract and writes to CACHE-tier Postgres tables — it never calls a write method. Verify: `grep -rn "writeContract" apps/indexer/` returns nothing.
- The API (`apps/api`) never writes to a CACHE table directly — only the indexer does, and only by replaying on-chain events. The API cannot manufacture a verdict, change claim status, or move funds. Verify: `grep -rn "prisma.resolution.create\|prisma.claim.update" apps/api/src/` — every hit traces back to an indexer-only code path, not an API route.
- All fund movement flows through one function, `_send_gen`, called only from `_settle_claim`, called only from consensus-gated write methods (`submit_for_judgment`, `raise_appeal`, `finalize_settlement`, `propose_human_settlement`, `claim_dispute_timeout`). Verify: `grep -n "_send_gen\|def _settle_claim" contracts/claimgame/contract.py`.
- Full capability matrix — every write method's authorization, state transition, value movement, and consensus method — is in [`docs/genlayer.md`](genlayer.md#contract-capability-matrix).

**Reproduce the adversarial lifecycle end to end:** `node scripts/product-test-1-full-lifecycle.mjs` — creates real accounts, locks real testnet GEN, submits a real challenge, triggers a real contract-side evidence fetch, reaches real validator consensus, and executes a real on-chain payout. Each write prints its own transaction hash and the actual vote tally read back from `getTransaction` — nothing in this path is mocked or simulated.

## Contract quality — where to look

- **Deterministic evidence pipeline** (fetch → normalize → excerpt → hash → judgment): `_fetch_and_extract_facts`, `_normalize_html_to_text`, `_extract_deterministic_excerpt` in [`contract.py`](../contracts/claimgame/contract.py) — checked via `strict_eq` since validators must reproduce byte-identical output from identical fetched bytes.
- **Substantive (not shape-only) consensus check:** `validator_fn` inside `_run_judgment` requires an exact `verdict` match plus a `payout_bps` match within a bucketed tolerance — documented with real historical disagreement data in [`docs/genlayer.md`](genlayer.md).
- **Adversarial test coverage:** [`tests/test_adversarial_inputs.py`](../tests/test_adversarial_inputs.py) — prompt-injection immunity, malformed/rotated/doubled-scheme URLs, conflicting evidence sources. This suite caught a real fail-open SSRF bug (doubled-scheme bypass), fixed in the same commit with a permanent regression test — concrete proof the methodology finds real bugs, not just checked boxes.
- **No-funds-stuck invariant:** every write method that can leave a claim in a non-terminal state (`NEEDS_HUMAN_REVIEW`, `PENDING_APPEAL`) has a corresponding permissionless recovery path (`claim_dispute_timeout`, `finalize_settlement`) with a fixed timeout — see the capability matrix's "Recovery/failure path" column.

## Engineering — where to look

- **One reviewer path:** clone → `pnpm install` → `pnpm run verify` → `node scripts/product-test-1-full-lifecycle.mjs` (all in [README.md](../README.md#live-verification)).
- **Release checklist:** [`docs/deployment-runbook.md#contract-redeploy-checklist`](deployment-runbook.md#contract-redeploy-checklist) — deploy address, env sync, cache rebuild, contract/source match, live smoke tests, captured evidence links.
- **Documentation truth audit:** every stale version/address/count reference found and fixed, logged in [`docs/genlayer.md`](genlayer.md) under "v0.3.11 — documentation truth audit + capability matrix."
- **Known, disclosed gap:** the GitHub Actions CI badge has never passed — this is an account-billing setting on a private repo (`gh api repos/.../actions/permissions` shows Actions enabled but every run shows `startup_failure`, 0 jobs), not a workflow defect. Disclosed directly under the badge in the README rather than hidden or silently removed. `pnpm run verify` reproduces every check that workflow would run.

## What is NOT claimed

- No claim of a passing CI badge (see above — disclosed, not hidden).
- No claim of IDN/homograph domain detection in `_is_safe_evidence_url` — documented as out of scope in that function's docstring and in `tests/test_adversarial_inputs.py`.
- No claim of network-layer SSRF protection beyond the contract's own host/range blocklist — a contract cannot control egress at the network layer; this is stated plainly in the function's own docstring and `docs/threat-model.md`.
- No claim that live-deployment or archive-pinning properties are "verified" anywhere they aren't backed by a command in this packet.
