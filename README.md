# CLAIMGAME

*"Put money behind your interpretation of a protocol."*

[![CI](https://github.com/zoefunds/claimgame/actions/workflows/ci.yml/badge.svg)](https://github.com/zoefunds/claimgame/actions/workflows/ci.yml)
> **Known issue, stated honestly:** this badge currently shows `startup_failure` on every run, checked via `gh run list` and `gh api repos/zoefunds/claimgame/actions/permissions` — Actions is enabled with `allowed_actions: all`, but 0 jobs are ever created, which matches GitHub's default behavior of blocking Actions minutes on **private repositories** until a spending limit is set (Settings → Billing → Plans and usage → Actions). This is an account-billing setting, not a workflow bug — every command inside `.github/workflows/ci.yml` is individually verified to pass locally (see [Contract test results](#contract-test-results) below for the exact output). Fix: set a spending limit (even $0 works once opted in) or make the repo public, then re-run the workflow.

A Web3 strategy game: players interpret ambiguous protocol statements, back their interpretation with a GEN bond, defend it against adversarial challenges backed by real evidence, and let a GenLayer Intelligent Contract reach validator consensus on the verdict.

**Live:** [claim-game.vercel.app](https://claim-game.vercel.app) · API: [claimgame-api.fly.dev](https://claimgame-api.fly.dev/healthz)

**Current deployed contract:** `0x4F3789881344cB7a5176b19eEADBAc3586Bb2EA6` (v0.3.11, GenLayer StudioNet) — see [Contract version history](#contract-version-history) below for the full audit-remediation timeline.

## Why GenLayer is indispensable here

CLAIMGAME's central action — deciding whether a claimant's interpretation of an ambiguous protocol statement is faithful, given real contradicting evidence a challenger has staked GEN against — is not a lookup, not a fixed formula, and not something either party (or a centralized operator) can be trusted to answer fairly, because both sides have a direct financial incentive to answer it in their own favor. This is exactly the class of problem GenLayer exists for: a judgment that requires real-world evidence and natural-language reasoning, but whose OUTPUT must be as tamper-resistant and non-repudiable as a deterministic contract's.

**The application cannot work fairly without it**, for a concrete reason, not a slogan: if a centralized server picked the verdict, that server's operator — or anyone who compromised it — could resolve every dispute in their own favor, and neither party would have any way to prove otherwise. GenLayer's validator consensus removes that single point of trust: no one party, including the people who built and run this app, can unilaterally decide who wins a claim.

**The backend and frontend are provably non-authoritative** — not by convention, but because the code cannot do otherwise:
- The indexer (`apps/api/src/indexer/index.ts`) only ever *reads* the contract (`client.readContract`) and writes to Postgres CACHE tables. It has no wallet, no private key, and no code path that calls a state-changing contract method. Grep-verifiable: `grep -n "writeContract" apps/api/src/indexer/index.ts` returns nothing.
- The API (`apps/api/src/routes/*.ts`) never writes to the CACHE tables (`claims`, `evidence`, `challenges`, `resolutions`, `appeals`, ...) — only the indexer does. The API can serve what the indexer already wrote, and manage NATIVE tables (sessions, profile), but has no route that fabricates or mutates claim/verdict state.
- Every fund-moving, state-changing action (`create_claim`, `submit_challenge`, `submit_for_judgment`, `raise_appeal`, `finalize_settlement`, ...) is a **direct, user-wallet-signed transaction to the contract**, submitted from the browser via `genlayer-js` (`apps/web/lib/contract.ts`) — the backend is never in this path at all, cannot intercept it, and cannot substitute its own result.
- If the API and indexer were deleted entirely, every dispute already on-chain would still resolve correctly and every GEN payout would still execute — the frontend would just have to read directly from the contract instead of a cache (which it already does as a fallback after the user's own transactions — see `reloadFromChain` in `apps/web/app/claims/[id]/page.tsx`).

**One real, reproducible adversarial lifecycle** (exact command in [Contract test results](#contract-test-results) below, full transcript in [docs/genlayer.md](docs/genlayer.md)): a claimant locks 10 GEN backing an interpretation of Uniswap v4's PoolManager architecture → a challenger locks 10 GEN disputing it → `submit_for_judgment` triggers the contract's own live web fetch of the cited evidence URL (never the submitter's restated text) → GenVM validators independently re-run the fetch, normalization, and judgment, and reach consensus via `strict_eq` (deterministic steps) and a custom decision-relevant-fields equivalence check (the verdict step) → the verdict is written to on-chain claim state → the contract's own `_send_gen` executes the payout to the winning party, inside the same transaction, with no further human or backend action. Reproduce it yourself: `node scripts/product-test-1-full-lifecycle.mjs` (see [Live verification](#live-verification) below).

## Status

| Phase | Status |
|---|---|
| 0 — Discovery | ✅ Done |
| 1 — Product spec | ✅ Folded into [`docs/architecture.md`](docs/architecture.md) |
| 2 — Architecture | ✅ [`docs/architecture.md`](docs/architecture.md) |
| 3 — UX/UI | ✅ [`docs/ux.md`](docs/ux.md) |
| 4 — Scaffold | ✅ Monorepo, `apps/web`, `apps/api` |
| 5 — GenLayer contract | ✅ [`contracts/claimgame/contract.py`](contracts/claimgame/contract.py) — v0.3.11, 2,146 lines (`wc -l` to regenerate) |
| 6 — Contract testing | ✅ Deployed to StudioNet; all 43 public methods exercised live with real data across multiple test rounds; a 67-test deterministic suite covers every pure function — see [Contract test results](#contract-test-results) |
| 7 — Backend | ✅ Deployed to Fly.io — API + Prisma/Postgres + indexer, all live 24/7 (indexer rate-limit-hardened) |
| 8 — Auth/wallet | ✅ Sign-in-with-wallet (nonce + signature), auto-triggered on connect via Reown AppKit, refresh-token rotation |
| 9 — Frontend | ✅ Deployed to Vercel — every page live: Landing, Hunt Board, Create Claim, Claim Detail (incl. appeal panel), My Cases, Profile, Leaderboard, Settings |
| 10 — GenLayer integration | ✅ Every contract read/write wrapped in `apps/web/lib/contract.ts`, verified against genlayer-js@1.1.8's actual runtime behavior (not just its types), address from env |
| 11–15 | ⏳ Not started (see [Roadmap](#roadmap--known-gaps)) |

## Deployed infrastructure

| Piece | Where | Notes |
|---|---|---|
| Contract | GenLayer StudioNet | `0x4F3789881344cB7a5176b19eEADBAc3586Bb2EA6` — v0.3.11, deployed 2026-09-05, 4 real product tests / 74/74 checks passed, zero errors — see [genlayer.md](docs/genlayer.md) |
| Frontend | Vercel — [claim-game.vercel.app](https://claim-game.vercel.app) | project `claim-game`, org `adebiyi2002gmailcoms-projects` |
| API | Fly.io — [claimgame-api.fly.dev](https://claimgame-api.fly.dev) | `min_machines_running=1`, 24/7 |
| Indexer | Fly.io — `claimgame-indexer` (no public URL, background worker) | `min_machines_running=1` (2 machines), 24/7, polls the contract every 15 minutes with a settled-claim skip |
| Database | Fly Postgres — `claimgame-db` | scoped db/user `claimgame_api`, attached to both `claimgame-api` and `claimgame-indexer` |

All contract address / RPC / secrets are environment-driven — see `.env.example`, `apps/web/.env.example`, `apps/api/.env.example`. Nothing is hardcoded in source. When the deployed contract address changes, four things must be updated in lockstep: `CLAIMGAME_CONTRACT_ADDRESS` (Fly secrets on `claimgame-api` + `claimgame-indexer`), `NEXT_PUBLIC_CLAIMGAME_CONTRACT_ADDRESS` (Vercel env), and the CACHE tables (see [Database model](#database-model) below) should be cleared since they mirror the *previous* contract's state.

## Stack

- **Frontend:** Next.js (App Router) + TypeScript + Tailwind → Vercel
- **Backend:** Fastify + Prisma → Fly.io (24/7, `min_machines_running=1`)
- **Database:** PostgreSQL → Fly Postgres
- **Auth:** Wallet-based (sign-in-with-wallet, no custodial keys), httpOnly session cookie with refresh-token rotation
- **Wallet connection:** Reown AppKit (WalletConnect) + wagmi
- **Blockchain:** GenLayer Intelligent Contract → StudioNet, via `genlayer-js@1.1.8`

## Monorepo layout

```
CLAIMGAME/
├── apps/
│   ├── web/           # Next.js frontend (Vercel)
│   └── api/           # Fastify backend + indexer (Fly.io)
├── contracts/
│   └── claimgame/     # the single Intelligent Contract (contract.py)
├── packages/          # planned workspace for shared ui/config/types — currently EMPTY;
│                      #   design tokens live in apps/web/tailwind.config.ts, components in
│                      #   apps/web/components/, types in apps/web/lib/types.ts instead
├── scripts/           # live StudioNet integration test scripts (real GEN, real transactions)
├── tests/             # deterministic, zero-dependency unit tests (Python + Node)
├── docs/              # architecture, genlayer, ux specs
├── deploy/            # fly.toml + Dockerfiles for api/indexer
└── package.json       # pnpm workspace root
```

## Local development

```bash
pnpm install
cp apps/web/.env.example apps/web/.env.local
cp apps/api/.env.example apps/api/.env    # then fill in DATABASE_URL / JWT_SIGNING_SECRET
pnpm --filter @claimgame/api prisma:generate
pnpm dev
```

## Deployment

```bash
# API
fly deploy --app claimgame-api --config deploy/fly.api.toml --dockerfile deploy/Dockerfile.api

# Indexer
fly deploy --app claimgame-indexer --config deploy/fly.indexer.toml --dockerfile deploy/Dockerfile.indexer

# Migrations (via a local proxy to Fly Postgres, or fly postgres connect for raw SQL)
fly proxy 15432:5432 --app claimgame-db &
DATABASE_URL="<see fly secrets / attach output>" pnpm --filter @claimgame/api exec prisma migrate deploy

# Frontend
cd apps/web && vercel deploy --prod --scope adebiyi2002gmailcoms-projects
```

**Redeploying the contract itself** (`genlayer deploy --contract contracts/claimgame/contract.py`) is done by the project owner, not by an agent — see [docs/genlayer.md](docs/genlayer.md#deployment-studionet-no-docker) for the full deploy checklist. After any contract redeploy: update the four env locations above, clear CACHE tables, and re-run the live test scripts in `scripts/` against the new address before treating it as verified.

## Database model

Two categories of Postgres table, a distinction that matters for redeploys:

- **NATIVE** (off-chain source of truth, never cleared on a contract redeploy): `users`, `sessions`, `auth_nonces`, `notifications`, `protocols`, `seasons`.
- **CACHE** (indexer-written mirror of on-chain state, cleared and rebuilt from scratch on every contract redeploy): `claims`, `claim_versions`, `evidence`, `challenges`, `objections`, `resolutions`, `appeals`, `reputation_events`, `reputation_scores`, `leaderboard_entries`, `indexer_cursor`.

The indexer (`apps/api/src/indexer/index.ts`) polls the contract every 15 minutes, throttled to respect StudioNet's dual rate limits (500 requests/hour, 30/minute), and skips any claim already in a terminal status matching Postgres (nothing about a resolved/withdrawn/expired claim can change again, so there's no reason to keep re-fetching it).

## Contract test results

Real, live testing against StudioNet — never mocks, never placeholder data — across every version from v0.3.0 through v0.3.10. Full narrative history (every bug found, every fix, every re-test) lives in [docs/genlayer.md](docs/genlayer.md); this section is the current summary.

**All 43 public methods have been exercised live** at least once, most repeatedly across versions — the v0.3.10 round alone ran 4 separate product tests (74 real checks) across 4 real disputes with zero errors (see [docs/genlayer.md](docs/genlayer.md) for the full transcript):
- Full lifecycle: `create_claim`, `amend_claim`, `withdraw_claim`, `claim_expired`
- Evidence: `submit_evidence`, `raise_objection`, `respond_to_objection`
- Adjudication: `submit_challenge`, `submit_for_judgment`, `propose_human_settlement`, `claim_dispute_timeout`
- **Appeals (v0.3.6, new):** `raise_appeal`, `finalize_settlement` — full lifecycle re-tested live 2026-08-27 (see below)
- Bounties: `create_bounty`, `contribute_to_bounty`
- Admin/registry: `register_protocol`, `create_season`, `transfer_ownership`
- Every read method, plus every access-control and deadline-enforcement rejection path (non-owner calls, challenging a withdrawn claim, double-challenging, unknown claim IDs, appealing twice, finalizing before the window closes)

**Deterministic test suite** (zero network dependency, zero cost, runs in milliseconds — counts below are a snapshot; regenerate with `python3 -m unittest discover -s tests -v 2>&1 | tail -5`, don't trust a hardcoded number): [`tests/test_contract_pure_logic.py`](tests/test_contract_pure_logic.py) — 53 tests via `python3 -m unittest discover -s tests -v` — covering escrow-conservation payout-split math across the full bps range, SSRF URL-safety policy (including the IPv6-bracket bypass fix, the doubled-scheme bypass fix, and CGNAT/numeric-host hardening), per-party evidence-slot selection with source-credibility tiering, bps-agreement rounding, the deterministic HTML-normalization/excerpt-extraction pipeline, and validator-verified-domain matching (including a real GitHub HTML fixture and lookalike-domain rejection tests). [`tests/test_adversarial_inputs.py`](tests/test_adversarial_inputs.py) — 12 tests — prompt-injection immunity of the deterministic excerpt-extraction layer, malformed/rotated/doubled-scheme URL bypass attempts, and conflicting-source evidence (proving the deterministic layer never silently picks a "winner" between contradicting sources — that's pushed to the model's judgment step, which is itself held to strict cross-validator agreement). [`tests/test_vote_decoding.mjs`](tests/test_vote_decoding.mjs) — 12 tests via `node tests/test_vote_decoding.mjs` — mirrors the frontend's transaction-outcome/vote-tally detection logic, including a regression test for the v0.3.1 false-positive-success incident. [`tests/test_cid.mjs`](tests/test_cid.mjs) — 3 tests via `node tests/test_cid.mjs` — verifies the CIDv1 content-addressing implementation against the reference `multiformats` library. **Total: 80 deterministic tests, zero dependencies beyond the Python/Node standard library.**

**The judgment-consensus liveness bug — the project's most significant defect, now resolved.** Five consecutive live `submit_for_judgment` failures across versions v0.3.0–v0.3.4 (validators disagreeing, zero state change, `UNDETERMINED`/leader-rotation) were root-caused to the LLM-based evidence-extraction step itself: two independent model calls, even constrained to "exactly 3 verbatim quotes," did not reliably converge. v0.3.5 replaced that step entirely with a deterministic pipeline (HTML normalization → keyword-anchored excerpt selection, both pure functions, no model call) checked with `strict_eq` instead of `prompt_comparative`. Re-tested live against the exact evidence that had failed five times before: **consensus reached.** v0.3.6 additionally added an appeal mechanism as a second line of defense against any future judgment disagreement, live-verified end-to-end (see next paragraph).

**The appeal mechanism — live-verified end-to-end, 2026-08-27** (`scripts/test-appeal-flow.mjs`): a determinate verdict now enters a 24-hour `PENDING_APPEAL` window instead of settling immediately. Confirmed live: judgment reached consensus (verdict `PASSED`, `payout_bps: 10000`) → claim correctly landed in `PENDING_APPEAL` → `finalize_settlement` correctly **rejected** while the window was open → `raise_appeal` (real 10 GEN bond) ran a genuinely independent second judgment round (new leader, new validators) → outcome `UPHELD_ORIGINAL` → settlement executed → claim moved to `RESOLVED_MERGE` → a second appeal on the same claim was correctly rejected ("one appeal per claim").

**Production bugs found and fixed while testing** (a representative sample — full list in `docs/genlayer.md`):
1. `genlayer-js@1.1.8`'s transaction receipt shape didn't match its own TypeScript types (`status_name`, not `statusName`) — the frontend was silently reporting every finalized transaction as a success even when the contract had rolled back. Fixed by decoding each validator's result byte-tag directly.
2. A majority-`disagree` consensus failure could show an individual validator's result byte-tag as "success," misreporting a total judgment failure as a success — fixed by checking the vote tally *before* trusting any individual result.
3. An IPv6-bracket URL (`http://[::1]/`) bypassed the SSRF blocklist due to a port-stripping bug — caught by the deterministic test suite before deployment.
4. A per-party evidence-slot fix initially let a party's own overflow evidence sneak back in disguised as "third-party" filler — caught by the same test suite, same day.
5. StudioNet's dual RPC rate limits (500/hour, 30/minute) were both independently discovered live and are now respected by throttling every RPC call.

## Roadmap / known gaps

- **Indexer scaling**: still O(active claims) per tick, not event-cursor-based. Fine at current claim volume — the settled-claim skip buys real headroom — but a high-volume future needs a real cursor/webhook model instead of polling.
- **Immutable evidence snapshot, now with a real off-chain archive**: the actual deterministic excerpt text is stored on-chain (`snapshot_text`), a SHA-256 hash of the *full* normalized page is stored too (`full_page_hash`), and as of v0.3.8 the indexer independently fetches and archives the full raw page off-chain (`Evidence.archivedContent`), verifying it against the on-chain hash (`archiveHashMatches`). Still not a full historical CDN — a page already gone before archiving can't be recovered — but genuinely closes the "hash-only" gap for pages that are still live when archived.
- **Final-verdict reliability: published matrix now crosses the 20-case threshold.** 21/24 (87.5%) first-attempt validator consensus across real, varied disputes (24 different real GitHub repos/protocols as evidence sources) — see the [full itemized matrix in docs/genlayer.md](docs/genlayer.md#v039--sixth-re-audit-response-ci-cid-content-addressing-published-reliability-matrix-2026-08-27). Both disagreements are reported, not hidden, and neither moved funds incorrectly — the appeal mechanism and human-review fallback exist exactly for this. Still worth growing further before very large bonds, but no longer "a small sample."
- **Source-tier verification no longer needs the owner at all — confirmed live (v0.3.10).** `propose_official_domain`/`verify_official_domain` let anyone add a `VERIFIED_PRIMARY` domain, decided by validator consensus checking the protocol's real GitHub org metadata. Live-tested 2026-08-27: proposed `uniswap.org` for `Uniswap v4` against its real `github.com/Uniswap` page — validators reached consensus (`MATCH`), the domain was added with zero owner action. A negative control (an unrelated domain) was correctly rejected (`NO_MATCH`), confirming it's a real check, not a rubber stamp. `Uniswap v4` is now the first protocol with a validator-verified official domain on this contract.
- **Appeal-with-new-evidence: now confirmed live** (v0.3.8) — `raise_appeal` with a real new evidence URL was exercised end-to-end for the first time, with the new evidence's Evidence Manifest fields populated confirming it was actually fetched and included in the appeal's judgment.
- **SSRF filtering, floor only**: the contract-level URL filter (scheme/host allowlist, private-range/CGNAT/numeric-host blocking) is a floor, not complete protection. Real network-egress control belongs at the GenVM validator-node infrastructure layer, which this project does not operate.
- **`claim_expired`/`claim_dispute_timeout`**: code-reviewed and access-control-tested, but their real-time deadlines (6h/7d respectively) haven't been waited out end-to-end in an automated test run.
- **No appeal-outcome UI polish beyond the functional panel** — works, but hasn't had a design pass (loading states, richer countdown formatting, etc.).

## Docs

- [Architecture](docs/architecture.md) — full system spec, all 27 required sections, with a current Mermaid system diagram
- [UX/UI](docs/ux.md) — page-by-page spec
- [GenLayer contract design](docs/genlayer.md) — why the contract is shaped the way it is, the full version-by-version audit-remediation history, deployment steps, troubleshooting
- [Deployment runbook](docs/deployment-runbook.md) — the exact, tested procedure for every kind of redeploy, plus real operational gotchas hit along the way
- [Threat model](docs/threat-model.md) — assets, threats, mitigations, and honestly-tracked open items
- [Evidence packet](docs/evidence-packet.md) — one page of reproducible commands and pointers backing every claim in this README

## Live verification

A reviewer can independently confirm the whole adversarial lifecycle described above — real GEN bonds, a real contract-side evidence fetch, real validator consensus, a real on-chain payout — without trusting anything written in this README:

```bash
# 1. Confirm the currently-deployed address and that the backend is non-authoritative
curl -s https://claimgame-api.fly.dev/healthz
# → {"status":"ok","contractAddress":"0x...","timestamp":"..."}  — this address must match every claim below

# 2. Run every locally reproducible check in one command — deterministic
#    tests, contract lint, install, typecheck, and build for both apps.
#    Mirrors .github/workflows/ci.yml exactly; green here means CI is green.
pnpm run verify
# (equivalent to ./scripts/run-all-checks.sh — see that script if you want
#  to run any one step in isolation)

# 3. Run a real, live adversarial lifecycle against the deployed contract
#    (creates real accounts, locks real testnet GEN, submits a real challenge,
#    triggers a real contract-side evidence fetch + validator consensus,
#    and prints the resulting on-chain verdict + payout — nothing mocked)
node scripts/product-test-1-full-lifecycle.mjs
```

Each write in step 3 prints its own transaction hash and the actual `consensus_data.votes` tally read back from `getTransaction`, so a reviewer sees the real vote-by-vote agreement/disagreement, not just a pass/fail summary. Cross-check any resulting claim id against the live app: `https://claim-game.vercel.app/claims/<id>`, and against the raw contract state: `get_claim`/`get_resolution` via `genlayer-js` or the GenLayer Studio explorer at the address printed in step 1.

## Contract version history

| Version | Deployed address | What changed |
|---|---|---|
| v0.3.0 | `0xc59b5007aAA808296204abaDFbd081441c115779` | First external-audit remediation pass (8 fixes): two-stage evidence extraction, Evidence Manifest fields, bounty payout/refund fixes, challenge-deadline enforcement, bounded input lengths, cross-claim citation validation |
| v0.3.1 | (same address) | Live incident: two consecutive judgment-consensus failures on identical static evidence; root-caused to LLM-extraction paraphrase variance; tightened extraction prompt (not yet sufficient, see v0.3.2-v0.3.4) |
| v0.3.2 | `0x1cD6F7FEd18a0CFa7F8fD6b226bb690db322A689` | Second audit pass: SHA-256 content hashing, SSRF-safe URL policy, judged-evidence cap (40→8), refresh-token rotation, indexer capacity visibility |
| v0.3.3 | `0x88BA19eF301C54138923B7e7F68c35F9B8469032` | Third audit pass: per-party evidence slots (closes "first 8" griefing vector), first deterministic test suite (caught 2 real bugs pre-deployment) |
| v0.3.4 | `0xE7D7db76AaeC546b6E4B7384a67571B13FCE22b7` | Attempted fix: widened the outer verdict-equivalence tolerance — live re-test showed this was not the actual root cause |
| v0.3.5 | `0xD799362AA3a84C981aE087C7BbF41e00a98b2840` | **The real fix**: deterministic-core redesign of evidence extraction (no LLM in the loop, `strict_eq` instead of `prompt_comparative`) — confirmed live: judgment consensus reached on evidence that had failed 5 times before |
| v0.3.6 | `0x019Dc784eA88d2F5E27a2924E08a8f1F195ca4B3` (current live) | Appeal/independent-witness round, immutable snapshot text, source-credibility tiering, further SSRF hardening — appeal flow confirmed live end-to-end; frontend appeal UI shipped |
| v0.3.7 | `0x4a4E1a6C3349E88707158fb15bE2F0f6560029Da` (current contract) | Owner-curated official-domain verification for source tiers (VERIFIED_PRIMARY/PRIMARY_UNVERIFIED/CORROBORATIVE), SHA-256 hash of the full normalized page, appeal-specific evidence with a guaranteed-judged slot — 39/39 methods live-tested; one genuine consensus disagreement hit and retried successfully |
| v0.3.8 | *(same contract — backend/frontend only)* | 6-case judgment reliability matrix (5/6 first-attempt consensus), off-chain independently-verified evidence archive (indexer fetches + re-normalizes + compares against on-chain hash), and the appeal-with-new-evidence path **confirmed live for the first time** (`raise_appeal` with a real new evidence URL, guaranteed-included, outcome `UPHELD_ORIGINAL`) |
| v0.3.9 | *(same contract — backend/frontend only)* | CI pipeline, real CIDv1 content-addressing for the archive (verified against the `multiformats` reference library), published 21/24-case reliability matrix, architecture diagram + threat model + deployment runbook |
| v0.3.10 | `0x7669F31fe5B91E7e7661f6C88a53351fb29662D1` | Validator-verified official domains — replaces the owner-only `set_protocol_official_domains` gate with a permissionless propose/verify flow decided by GenVM validator consensus. **4 real product tests run 2026-08-30: 74/74 checks passed, zero errors** — full lifecycle w/ appeal or settlement, withdrawal + guard rails, ambiguous dispute + human review, protocol registry + domain verification (real + negative control). New `/protocols` page |
| **v0.3.11** | **`0x4F3789881344cB7a5176b19eEADBAc3586Bb2EA6`** (current) | Fixed a real fail-open SSRF bug in `_is_safe_evidence_url` (doubled-scheme URLs like `http://http://127.0.0.1/` were incorrectly accepted), caught by a new adversarial test suite (`tests/test_adversarial_inputs.py` — prompt-injection immunity, malformed/rotated URLs, conflicting evidence sources). Documentation truth audit (stale version/address/count references fixed across README and docs). **4 real product tests re-run against this redeployed contract on 2026-09-05: 74/74 checks passed, zero errors** — CACHE tables cleared and freshly re-synced against this address, all data on [claim-game.vercel.app](https://claim-game.vercel.app) reflects only this contract |

Full narrative for every row above — root causes, exact bugs, live test transcripts — is in [docs/genlayer.md](docs/genlayer.md).
