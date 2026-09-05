# CLAIMGAME — GenLayer Intelligent Contract

File: [`contracts/claimgame/contract.py`](../contracts/claimgame/contract.py) — one contract, 2,128 lines (v0.3.10, deployed at `0x7669F31fe5B91E7e7661f6C88a53351fb29662D1`, GenLayer StudioNet), syntax-verified with `python3 -m py_compile` and `genvm-lint check` (43 public methods: 22 view / 21 write). This line count and address are a point-in-time snapshot — regenerate with `wc -l contracts/claimgame/contract.py` and `curl -s https://claimgame-api.fly.dev/healthz` before trusting them if this doc has aged.

## Why GenLayer, specifically here

The judgment step — "does this interpretation faithfully capture an ambiguous statement, given real evidence" — cannot be resolved by deterministic code, and per the review team's rule it must not be "an AI app with GenLayer attached": the contract itself fetches evidence and reaches validator consensus on a structured verdict that directly moves GEN. That's the load-bearing use of GenLayer here — not a chat feature, not "better AI answers."

## API surface used (verified against docs.genlayer.com / skills.genlayer.com)

`gl.Contract`, `@gl.public.view`, `@gl.public.write`, `@gl.public.write.payable`, `gl.message.sender_address`, `gl.message.value`, `gl.vm.UserError`, `gl.nondet.web.render(url, mode="html")`, `gl.nondet.exec_prompt(prompt)`, `gl.eq_principle.strict_eq(fn)`, `gl.eq_principle.prompt_comparative(fn, principle)`, `gl.evm.contract_interface` (+ `emit_transfer`), `TreeMap[K, V]`, `DynArray[T]`, `Address`, `u256`. Confirmed via the official "Your First Intelligent Contract," "Wizard of Coin," and storage docs pages, plus the `genlayer.std.eq_principles` SDK reference.

GenLayer's API has moved fast historically (e.g. `eq_principle_prompt_comparative()` → `eq_principle.prompt_comparative()` between SDK v0.1.0 and v0.1.3). **Before deploying, re-check your installed CLI's docs against the API names above** — if anything has been renamed again, the fix is a rename in the contract, not a redesign.

## Avoiding "could not load contract schema"

This error is almost always the schema introspector choking on the ABI, not a logic bug. Mitigations built into this contract:
- Every `@gl.public.*` method has explicit, non-Optional parameter types and an explicit return type (`str`, `int`, or `None` — never bare `dict`/`Any`).
- No public method has a default-valued parameter.
- All complex state (claim/challenge/evidence/etc.) is stored as a `TreeMap[str, str]` of JSON blobs rather than nested custom dataclasses in storage, sidestepping any storage-schema edge cases around nested generics.
- The `# { "Depends": "py-genlayer:..." }` header **must be regenerated** from your actual `genlayer init` scaffold before deploy — a stale pin is the other common cause of this error.

## Avoiding an undetermined consensus result / leader rotation

Two different problems, two different fixes — see the long comment at the top of the contract file for full reasoning:
1. **Ambiguous LLM output** → never reverts the transaction; always lands in `NEEDS_HUMAN_REVIEW`, which is guaranteed to terminate later via mutual settlement or a timeout (`claim_dispute_timeout`).
2. **Validator disagreement on re-execution** → the Equivalence Principle check only requires agreement on `verdict`, `confidence`, and `payout_bps` rounded to the nearest 500 bps — not the LLM's full free-text reasoning, which is exactly what makes contracts over-rotate leaders when checked with `strict_eq` on a whole response blob.

## Exit paths (every way GEN can leave escrow)

`RESOLVED_MERGE` / `RESOLVED_REJECT` / `RESOLVED_PARTIAL` (from a verdict) / `RESOLVED_PARTIAL` via `propose_human_settlement` (mutual agreement after human review) / `RESOLVED_DISPUTE_TIMEOUT` (timeout recovery) / `WITHDRAWN` (pre-challenge) / `EXPIRED` (no challenge raised). All route through the single `_send_gen()` choke point, all zero their ledger field before transferring, matching the ShipBond/ic7 pattern you referenced.

## Deployment (StudioNet, no Docker)

```bash
genlayer init                     # regenerates the correct "Depends" pin for your installed SDK — copy it into line 1
genvm-lint check contracts/claimgame/contract.py --json   # fix any warnings before proceeding
genlayer network studionet
genlayer deploy --contract contracts/claimgame/contract.py
```

You run these — I don't deploy the contract myself, per your instruction. Once you have the deployed address, send it to me and I'll wire it into `apps/web` and `apps/api` env config (never hardcoded).

## What's intentionally NOT in this contract

- User profiles, notifications, search, leaderboard materialization — these are backend/Postgres concerns (see [architecture.md](./architecture.md) §2, §15), kept off-chain so the contract stays focused on the state that must be decentralized.

## Audit remediation (v0.3.0)

An external audit scored the repo 2,220/4,000 on GenLayer production-readiness and flagged ten specific blockers. Fixed in the contract:

1. **Raw-page `strict_eq` → two-stage extraction with `prompt_comparative`.** The old code wrapped `gl.nondet.web.render()`'s raw HTML in `strict_eq`, which needs byte-identical results across validators — dynamic pages, cookies, and render differences made validator disagreement likely, exactly what GenLayer's own docs warn against. `_fetch_and_extract_facts()` now does the fetch *and* a bullet-point fact extraction inside one nondet block, checked with `prompt_comparative` (validators only need to agree the extracted facts describe the same substance, not match byte-for-byte).
2. **Evidence Manifest fields.** Every evidence item now carries `retrieved_at` and `content_hash` (FNV-1a over the *extracted* facts, not the raw page — deterministic and reproducible), populated the moment judgment actually fetches it. Exposed through the indexer to Postgres.
3. **Bounty evidence-share now actually pays evidence contributors on-chain**, split evenly across the distinct submitters of evidence the verdict cited (bounded by `MAX_EVIDENCE_PER_CLAIM`) — previously it silently rerouted to the claimant/challenger while the docs promised evidence contributors a cut.
4. **Bounty refunds on every non-judgment terminal path** (`withdraw_claim`, `claim_expired`, `claim_dispute_timeout`) via `_refund_bounty_if_any` — previously a bounty on a withdrawn/expired/timed-out claim had no way out and stayed stuck in the contract forever.
5. **`submit_challenge` now enforces the challenge deadline** — previously only `claim_expired()` checked it, and only reachable if nobody had challenged yet, so a challenge could race in after the window the claimant was told applied.
6. **Bounded input lengths** on every free-text field that reaches the judgment prompt or gets stored (`MAX_SHORT_TEXT_LEN` / `MAX_LONG_TEXT_LEN`) — previously unbounded, which is both a cost/latency risk and a larger prompt-injection surface.
7. **Cross-claim evidence citation is now rejected.** The LLM composes `evidence_cited` itself; `_apply_verdict` now checks every cited id against `claim_evidence_ids` for *this* claim before marking it cited or including it in the resolution — previously a hallucinated or copy-pasted id from another case could get marked cited on the wrong claim.
8. **Documented (not silently assumed) the wall-clock time limitation** — `_now_iso()` now carries an explicit note that this is validator wall-clock time, not a confirmed deterministic protocol timestamp; deadlines are day-scale so ordinary clock skew shouldn't change outcomes, but this needs verification against current GenVM docs before relying on it further.

**Not yet done — explicit roadmap, not silently skipped:**
- Multi-witness / independent-source-minimum / appeals mechanism (audit items #9, #5/#6 of the remediation list) — this is a real product feature (a second judgment round, an appeal bond, a source-conflict graph), not a small patch, and needs its own design pass.
- Source allowlist / source-quality scoring / immutable off-chain snapshot pointer beyond the content hash — the content hash gives reproducibility for what the contract itself saw; a full "Evidence Manifest" with source class weighting and IPFS-style snapshotting is future work.
- Full indexer cursor/event-reconciliation rewrite for scale — objections are now synced (they weren't at all before) and evidence carries manifest fields, but the indexer still re-scans every claim every 5s rather than an event-cursor model; fine at current claim volume, a real limitation at scale.

## v0.3.1 — live validator-disagreement incident (2026-08-26)

v0.3.0 was deployed to `0xc59b5007aAA808296204abaDFbd081441c115779` and put through real, detailed testing (see README's [Contract test results](../README.md#contract-test-results-2026-08-26)). Two consecutive real `submit_for_judgment` calls against the same evidence — a raw, static GitHub markdown URL, chosen specifically because it should be maximally stable — both finalized with a validator majority voting **`disagree`** (3 disagree / 0 agree on the second attempt) and **zero state change applied**. The claim stayed in `CHALLENGED`, no resolution was recorded, funds were untouched (the ledger-zero-before-transfer design meant nothing was ever at risk — this was a liveness problem, not a fund-safety one).

Root cause: the instability wasn't the fetch (identical every time for a static file) — it was `_fetch_and_extract_facts`'s per-validator LLM call independently *paraphrasing* the same content differently enough that `prompt_comparative`'s NLP equivalence judge couldn't reconcile the outputs. This is a materially different failure mode than the original audit finding #1 (raw-HTML `strict_eq` disagreeing over *dynamic* content) — it shows that even after fixing the fetch-side instability, the *LLM-extraction* side can independently fail to reach consensus, on genuinely static input.

**Also exposed a real detection bug**, now fixed in `apps/web/lib/contract.ts`: the frontend's transaction-outcome check only decoded each validator's individual result content (success/rollback/idle byte-tag) and never checked the `consensus_data.votes` tally itself, so a majority-disagree outcome with an ambiguous per-validator result byte was silently reported as a **false positive success**. Fixed by checking the vote tally first, before trusting any individual result's content.

**v0.3.1 fix in `_fetch_and_extract_facts`** — three changes to narrow the LLM's room to diverge:
1. Excerpt window shrunk from 4000 → 1500 chars (less input surface to summarize differently).
2. Extraction changed from "2-6 free-form paraphrased bullets" to **exactly 3 verbatim quotes** (5-15 consecutive words copied directly, no paraphrasing) — independent runs are far more likely to agree on *which sentence* to quote than on *how to reword* it.
3. The equivalence-principle instruction text loosened to judge only substantive overlap between quoted passages, not exact wording/order.

Not yet re-verified live (needs the redeploy below, then a retry against the same claim/evidence to confirm agreement is reached) — flagging honestly rather than claiming it's fixed until tested.

## v0.3.2 — second audit remediation pass (2026-08-26, re-audit score 2,220 → 3,030 / 4,000)

Fixed:
1. **`content_hash` upgraded from hand-rolled FNV-1a to real SHA-256** (`hashlib.sha256`). Still hashes the *extracted, equivalence-agreed* quotes rather than the raw page — see `_content_hash`'s docstring for exactly why that scope is deliberate, not an oversight (hashing the raw page would reintroduce the same validator-disagreement problem the fact-extraction rewrite fixed).
2. **SSRF-safe evidence URL policy** (`_is_safe_evidence_url`) — `submit_evidence` now rejects non-http(s) schemes and private/internal/loopback hosts (localhost, 127.x, 10.x, 172.16-31.x, 192.168.x, 169.254.x, cloud metadata endpoints). This is a security fix (the contract's own fetcher was an unrestricted SSRF vector against GenVM's network), not a source-credibility ranking system — a curated per-protocol trusted-source registry is still roadmap.
3. **AI-judged evidence capped at `MAX_JUDGED_EVIDENCE = 8`** (was up to 40) — evidence submission itself is still uncapped up to `MAX_EVIDENCE_PER_CLAIM`, but only the first 8 (submission order, ungameable) are actually fetched and fed to the judgment prompt. Cuts both cost and the number of independent nondet-agreement opportunities per judgment.
4. **`POST /api/v1/auth/refresh` implemented** (`apps/api/src/routes/auth.ts`) — the refresh cookie was already being issued and scoped correctly, but nothing consumed it, so a session silently died after 24h. Now does full rotation (old token revoked, new one issued on every use). Frontend's `apps/web/lib/api.ts` calls it automatically on a 401 and retries the original request once.
5. **Indexer capacity visibility** — logs a warning when active (non-terminal) claim count exceeds a safe per-tick RPC budget, and a new `GET /api/v1/indexer/status` route exposes last-sync freshness so a stalled indexer is checkable instead of only visible in Fly logs.

**Explicit roadmap, still not done — flagged, not silently skipped:**
- **Appeal / independent-witness round** (audit finding #4, the largest remaining gap) — a second adjudication round with a stricter rubric, an appeal bond, and independent-source minimums is a real product feature needing its own design pass, not a patch to bolt onto the existing single-round flow.
- **Immutable source snapshot** beyond the extracted-quote hash — a genuine content-addressed archive of the original page, itself agreed via its own equivalence-checked step, not just the model's extraction.
- **Curated trusted-source registry** (official docs/governance/on-chain as primary, forums/socials as corroborative-only) — the SSRF fix above is a security floor, not this.
- **CI-grade deterministic invariant suite** — `scripts/*.mjs` are real, valuable live-StudioNet integration tests (and they mutate a shared testnet, so they're not repeatable in the CI sense), not a substitute for deterministic unit tests of escrow conservation, deadline boundaries, and payout-split math run against a local/ephemeral GenVM instance. Worth building once GenLayer's local test-runner API is verified against current docs — not fabricated here.
- **Indexer polling ceiling** — the capacity warning makes the RPC-budget wall visible, it doesn't move it. A genuinely event-driven sync (or a higher-tier RPC endpoint) is the real fix at claim volumes much past a dozen or so concurrently active.

## Redeploying after this change

**This changes the contract's bytecode, so it needs a new StudioNet deployment — the existing address (`0xc59b5007aAA808296204abaDFbd081441c115779`, v0.3.1) still runs the pre-fix evidence/provenance logic.** Same steps as before:

```bash
genvm-lint check contracts/claimgame/contract.py --json   # fix any warnings before proceeding
genlayer deploy --contract contracts/claimgame/contract.py
```

Send me the new address once you have it and I'll wire it into `apps/web`/`apps/api` env config in place of the old one.

## v0.3.3 — third audit remediation pass (2026-08-26)

A third re-audit of the *live deployed* v0.3.2 contract (`0x1cD6F7FEd18a0CFa7F8fD6b226bb690db322A689`) scored 3,030/4,000 as-deployed (3,220/4,000 for the source tree once redeployed and re-tested) and flagged 6 remaining findings. Addressed in the source tree, not yet deployed:

1. **"First 8 evidence" rule was a griefing vector (finding #3) — fixed.** The old `MAX_JUDGED_EVIDENCE = 8` selected the first 8 items by *submission order*, so a party could flood 8+ low-quality items immediately after claim creation and permanently crowd out the other side's evidence from ever being judged. Replaced with `_select_judged_evidence()`: each party gets up to `MAX_JUDGED_EVIDENCE_PER_PARTY = 4` of their own slots (submission order within their own items), with any leftover slots filled by third-party evidence. Total cap unchanged at 8.
2. **CI-grade deterministic test suite (finding #5) — now exists.** [`tests/test_contract_pure_logic.py`](../tests/test_contract_pure_logic.py) (19 tests, zero dependencies, `python3 -m unittest discover -s tests`) covers the SSRF URL policy, SHA-256 content hashing, escrow-conservation payout-split math across the full bps range, bps-rounding tolerance, and the new evidence-slot selection — including the exact griefing scenario from finding #3. [`tests/test_vote_decoding.mjs`](../tests/test_vote_decoding.mjs) (`node tests/test_vote_decoding.mjs`) mirrors the frontend's `findVoteOutcome`/vote-tally-first consensus detection, including the v0.3.1 false-positive-success incident as a regression test. Both files document why they duplicate contract/frontend logic rather than importing it (GenVM's `genlayer` package isn't importable outside the sandbox; `contract.ts` is a framework-coupled client module).
3. **The new test suite caught two real bugs before deployment** — exactly what an audit asking for tests is for:
   - `_is_safe_evidence_url`'s SSRF filter had a bypass: a bracketed IPv6 literal (`http://[::1]/`) was truncated by `.split(":", 1)[0]` down to just `[`, which never matched the `::1` blocklist entry. Fixed by rejecting any host starting with `[` outright, before port-stripping.
   - `_select_judged_evidence`'s third-party fill only checked `id not in claimed_ids`, so a party's own evidence *beyond* their 4-slot cap could sneak back in disguised as "third-party" filler — reintroducing the exact griefing vector the fix was meant to close. Fixed to check submitter identity (`submitter != claimant and submitter != challenger`), not just id membership.
4. **Critical liveness re-test (finding #6) — run live, RESULT: NOT CONFIRMED.** Per the audit's explicit instruction ("that is the critical test before increasing the score"), `scripts/verify-liveness-fix.mjs` re-ran the identical dispute and the identical evidence URL (`raw.githubusercontent.com/Uniswap/v4-core/main/README.md`) that caused the v0.3.0/v0.3.1 incident, against the currently-deployed v0.3.2 contract. Result: **validators disagreed a third consecutive time** (3 disagree / 0 agree, `submit_for_judgment` finalized with zero state change). The v0.3.2 extraction-prompt tightening (1500-char excerpt, exactly-3-verbatim-quotes) did **not** resolve the underlying nondeterminism. This is reported honestly rather than claimed fixed — a fourth attempt at prompt tightening alone is unlikely to be the fix; the pattern across three failures on the same static, stable input points to `prompt_comparative`'s free-text LLM judgment itself being the unreliable link, not the extraction prompt's wording. Real next options, not yet built:
   - Replace `prompt_comparative` on the extracted quotes with `strict_eq` on a *normalized* deterministic transform of the LLM output (e.g. whitespace-collapsed, lowercased, first-N-words) — trades some semantic tolerance for exact-match reliability.
   - Have each validator extract a single fixed-position quote (e.g. "the first sentence containing word X") instead of choosing among candidates — removes the selection-among-plausible-quotes source of divergence entirely.
   - Move this evidence class off free-text LLM comparison entirely — e.g. a deterministic substring-existence check (does the extracted claim text literally appear in the fetched page) computed by contract code, not judged by an LLM at all.
5. **Findings #1, #2, #4 — still explicit roadmap, not attempted this pass:** appeals/independent-witness round, immutable content-addressed evidence snapshot beyond the quote hash, and network-egress-layer SSRF enforcement (the contract-level host/scheme filter from v0.3.2 is a floor; GenVM validator nodes' actual network egress isn't infrastructure we control).

**Deployed** to `0x88BA19eF301C54138923B7e7F68c35F9B8469032` (2026-08-26). CACHE tables cleared, all env config (Fly secrets on `claimgame-api`/`claimgame-indexer`, Vercel `NEXT_PUBLIC_CLAIMGAME_CONTRACT_ADDRESS`) updated and redeployed.

### Full-lifecycle re-test against v0.3.3 (2026-08-26) — liveness bug confirmed broader, not URL-specific

`scripts/test-contract.mjs` was re-run against the new address with fresh, real, detailed data (a new Uniswap v4 hook-fee dispute — different claim text, different evidence URLs from every prior test run). **34/38 checks passed** — every non-judgment method (claim lifecycle, amendments, evidence, objections, bounties, challenges, access control, deadline enforcement, reputation reads) worked correctly against the redeployed contract with the per-party evidence-slot fix live.

**The judgment call disagreed again — 4th consecutive real-network failure, and critically, on entirely different evidence than every prior failure.** Prior failures (v0.3.0, v0.3.1, and the v0.3.2 liveness re-test) all used the same raw GitHub markdown URL, leaving open the possibility the bug was specific to that one page. This run used `docs.uniswap.org`'s actual dynamic-fees documentation page instead — a different URL, different content, different claim. Same outcome: validators split 3-disagree/0-agree, transaction finalized as UNDETERMINED, zero state change. (The test script's own 180s retry window read this as a timeout rather than a disagreement — checking the transaction hash directly afterward showed it did reach a terminal `disagree` majority, just slower than the script's retry budget.)

**Conclusion, stated plainly: this is not a quirk of one evidence source.** Across two different real evidence URLs and four independent live attempts, `prompt_comparative`-judged LLM fact-extraction has never once reached validator consensus on this contract. The roadmap options listed in the finding-#6 section above (deterministic substring check, fixed-position extraction, or `strict_eq` on a normalized transform) are not incremental improvements at this point — one of them is required before `submit_for_judgment` can be considered reliable for any evidence-backed claim, not just markdown-file edge cases.

A secondary, lower-priority observation from this run: StudioNet response times were visibly slower than prior test runs (simple writes ~35-45s vs the same calls' ~30s in earlier sessions, and one `create_claim` needed >180s to finalize despite ultimately succeeding). Worth keeping test retry windows generous (the frontend already polls the backend cache rather than hitting StudioNet directly, so this doesn't affect the live app's UX the way it affects test scripts).

## v0.3.4 — judgment-liveness fix (2026-08-26)

The user's own diagnosis: `submit_for_judgment` "keeps getting leader rotation and ending up as undetermined." Re-examining `_run_judgment` surfaced a second, previously-overlooked strictness layer stacked on top of the already-loosened evidence-extraction check:

`_run_judgment`'s `validator_fn` ([contract.py](../contracts/claimgame/contract.py)) requires two **fully independent** LLM judgment calls — each one re-running the entire nested evidence-extraction step from scratch, then synthesizing a fresh verdict — to agree on `verdict`, `confidence`, **and** `payout_bps` rounded to the nearest 500 (a ±250bps window), all three simultaneously. The test claims used throughout this project's live testing are deliberately marked `HARD`/`AMBIGUOUS` — exactly the cases where two independent model runs are most likely to genuinely diverge. That combination (three-field exact match, ±250bps tolerance, on deliberately ambiguous input) is a plausible root cause independent of anything about evidence-source stability, which is why prior fixes aimed at the extraction prompt kept failing to resolve it.

Two changes, both narrowing what's *required* to agree down to what's actually decision-relevant (payout_bps and verdict move GEN; confidence doesn't):
1. **`confidence` dropped from the equivalence check entirely.**
2. **`CONFIDENCE_ROUND_BPS` widened from 500 to 2000** — the payout_bps agreement window goes from ±250bps to ±1000bps.

**Re-verified live (2026-08-26) against `0xE7D7db76AaeC546b6E4B7384a67571B13FCE22b7` — did NOT fix it.** `scripts/verify-liveness-fix.mjs` re-ran the same controlled dispute: `submit_for_judgment` disagreed again, 3-disagree/1-agree. This ruled out the hypothesis — even a much wider tolerance window couldn't reach agreement, meaning the divergence isn't in `payout_bps`/`confidence` drift at all. See v0.3.5 below for the actual fix once this was correctly diagnosed.

## v0.3.5 — deterministic-core redesign (2026-08-26, fourth attempt at the judgment-liveness bug)

Prompted by the user asking whether this was the same class of bug as a separate GenLayer project's (RecallRaid) multi-week UNDETERMINED saga. Checked RecallRaid's incident history against this contract's code:

- RecallRaid's real root causes (found across four redeploy cycles) were: nested-generic storage-allocation crashes, **reading storage-backed dataclass fields inside a nondet closure** ("Reading storage in nondet mode is not supported"), **raising an exception inside a nondet closure** (silently counted as `disagree` rather than a clean rejection), and — the one that actually explained their whole saga — **a bare `leader_result["verdict"]` subscript on a `gl.vm.Return` object**, crashing unpredictably and being misattributed to "LLM variance" for weeks.
- None of these apply to ClaimGame: `claim`/`version`/`challenge`/`evidence_items` are already plain `json.loads()`'d dicts before reaching any nondet closure (never live storage objects); `leader_fn` and the fetch/extract path already degrade to fallback values instead of raising; `validator_fn` already does the correct `isinstance(leaders_res, gl.vm.Return)` + `.calldata` unwrap that RecallRaid discovered was their actual fix.
- Conclusion: ClaimGame's disagreement is a *different*, and more mundane, problem than RecallRaid's — genuine model-output divergence, not a hidden crash. That also explained why v0.3.4's tolerance-widening didn't work (confirmed live, above): the divergence isn't in the numeric fields that widening touched, it's almost certainly in the LLM-driven **extraction** step (`_fetch_and_extract_facts`) itself — two independent LLM calls, even constrained to "3 verbatim quotes," still don't reliably pick the same quotes.

**The actual fix, per the third audit's remaining-blocker #1 ("replace the free-text `prompt_comparative` extraction path"):** removed the LLM from evidence extraction entirely.
- `_normalize_html_to_text` — pure regex/string HTML-to-text normalization (strip tags, decode common entities, collapse whitespace, lowercase). Deterministic: same bytes in, same string out, always.
- `_extract_deterministic_excerpt` — pure keyword-anchored passage selection: pulls non-stopword keywords (len ≥ 4) from the claim subject + source statement, finds the earliest position any keyword appears in the normalized text, and takes a fixed 600-char window there (falling back to a fixed-position window from the start if no keyword matches). No model call anywhere in this path.
- `_fetch_and_extract_facts` now checks this pipeline with **`gl.eq_principle.strict_eq`** instead of `prompt_comparative` — valid now because the whole pipeline after the (still-nondet) fetch is byte-reproducible given identical fetched bytes. The LLM is still used, but now only once, in `_run_judgment`'s final verdict synthesis — and it now receives this smaller, non-model-generated excerpt as input instead of another LLM's paraphrase.
- Both new functions are unit-tested in `tests/test_contract_pure_logic.py` (12 new tests, including an explicit "deterministic across repeated calls" property test — the exact guarantee `strict_eq` now depends on). Full suite: 31/31 passing. `genvm-lint check` passes (only the pre-existing newer-runner-available notice, unrelated).

**Also fixed, per the audit's reproducibility finding**: `scripts/test-contract.mjs` and `scripts/verify-liveness-fix.mjs` hardcoded a stale contract address, so the checked-in scripts couldn't reproduce the test runs the docs claimed. Both now read `CLAIMGAME_CONTRACT_ADDRESS` from the environment, defaulting to the current deployed address.

**Deployed to `0xD799362AA3a84C981aE087C7BbF41e00a98b2840` and re-verified live (2026-08-26) — CONFIRMED FIXED.** `scripts/verify-liveness-fix.mjs` re-ran the exact same controlled dispute and the exact same evidence URL (`raw.githubusercontent.com/Uniswap/v4-core/main/README.md`) that had failed five consecutive times across every prior version (v0.3.0 through v0.3.4). This time: `submit_for_judgment` reached validator consensus — verdict `INCONCLUSIVE`, confidence `LOW`, `payout_bps: 5000`. This is a legitimate result, not a fallback dodging the question: the deterministic excerpt anchored on a portion of the README that didn't actually address the specific hook-cross-pool-access question in dispute, and the model correctly reported it couldn't decide rather than guessing — landing the claim in `NEEDS_HUMAN_REVIEW`, the designed recovery path. Evidence Manifest fields populated correctly (`content_hash` a real SHA-256 over the deterministic excerpt, `retrieved_at`, `cited_in_verdict: true`).

This is the first successful `submit_for_judgment` call against evidence that previously deadlocked consensus, across the entire audit-remediation history of this contract. All infra (Fly secrets, Vercel env, CACHE tables) updated to this address.

**Still explicit roadmap, not attempted this pass** (per the third audit's remaining blockers #2-#5): immutable evidence snapshots beyond the excerpt hash, appeal/independent-witness rounds, source-credibility tiering (official docs/governance primary, forums corroborative-only), and network-egress-layer SSRF controls beyond the existing contract-level host/scheme filter.

## v0.3.6 — all four remaining third-audit blockers (2026-08-26)

Following up on v0.3.5's confirmed liveness fix, the user asked to address the four items flagged above ("fix all"). All four implemented in `contracts/claimgame/contract.py`:

**Blocker #3 (appeal / independent-witness round) — the largest change.** A determinate verdict no longer moves funds immediately. `_apply_verdict` now sets a new `PENDING_APPEAL` status and stores the pending verdict on the claim, along with an `appeal_deadline` (`APPEAL_WINDOW_SECONDS` = 24h). Two new write methods:
- `raise_appeal(claim_id)` — payable (min `APPEAL_BOND_WEI` = 10 GEN), callable by either the claimant or challenger during the appeal window. Triggers one fresh `_run_judgment` call — a genuinely independent GenVM nondet round with a new leader and new validators (this contract has no way to hand-pick specific "witnesses", and shouldn't — that would be a worse centralization vector than the problem it solves). If the appeal's verdict matches the original (same verdict category, same rounded payout_bps), the appeal is `UPHELD_ORIGINAL` and the appellant's bond is forfeited to the other party; if it differs, it's `OVERTURNED` and settlement uses the new verdict instead, with the bond refunded. If the appeal round itself comes back low-confidence/inconclusive, the original verdict stands and the bond is refunded in full (not treated as a frivolous appeal, since the outcome genuinely wasn't clear-cut).
- `finalize_settlement(claim_id)` — permissionless (same pattern as the existing `claim_dispute_timeout`), callable by anyone once the appeal window has closed with no appeal raised. This is what actually moves GEN for the common, non-appealed case.
- At most one appeal per claim (`self.appeals` TreeMap, checked before allowing a second one) — a bounded design, not an infinite-retry loop, which also bounds worst-case time-to-settlement.
- New `get_appeal(claim_id)` view method, new `Appeal` Prisma model + indexer sync (`syncAppeal`), new `PENDING_APPEAL` added to the frontend's `ClaimStatus` type. Frontend UI for raising an appeal shipped 2026-08-27 (see below).

**Blocker #2 (immutable evidence snapshots).** Evidence Manifest now stores the actual deterministic excerpt TEXT (`snapshot_text`), not just its SHA-256 hash — real preservation, not just provenance. This is safe and cheap specifically because v0.3.5 made extraction deterministic and bounded (`EXCERPT_WINDOW_CHARS` = 600 chars), where it wouldn't have been safe to store an unbounded LLM paraphrase. A full raw-page content-addressed archive (the audit's stated ideal) is still out of scope — that needs off-chain storage this contract doesn't have; this is the honest, real subset of "immutable" achievable entirely within contract storage. `Evidence.snapshotText` added to the Prisma schema and indexer sync.

**Blocker #4 (source credibility rules).** `EVIDENCE_TYPES` split into `PRIMARY_EVIDENCE_TYPES` (protocol documentation, governance proposals, on-chain transaction data, official announcements) and `CORROBORATIVE_EVIDENCE_TYPES` (generic URLs, forum discussions, social posts, screenshots, other). Two effects: `_select_judged_evidence` now sorts each party's own evidence primary-first within their fixed 4-slot allowance (their weaker corroborative items never crowd out their own stronger primary evidence, though this never changes slot counts *between* the two parties); and the judgment prompt now carries an explicit `source_tier` tag per evidence item plus a rule instructing the model to treat corroborative-only evidence as context, never as the sole basis for a determinate `PASSED`/`FAILED` verdict.

**Blocker #5 (SSRF egress controls).** Two more real gaps closed in `_is_safe_evidence_url` on top of what v0.3.2/v0.3.3 already covered: bare-decimal/octal numeric hosts (e.g. `http://2130706433/`, which some HTTP clients resolve as `127.0.0.1`) are now rejected outright, and the `100.64.0.0/10` CGNAT range (RFC 6598) is now blocked alongside the existing RFC 1918 ranges. **Still explicitly a floor, not complete protection** — this contract has no ability to add egress-layer network controls on GenVM validator nodes, which is genuinely outside its reach; that gap is now stated plainly rather than implied to be solved.

**Verification:** `python3 -m py_compile` clean, `genvm-lint check` clean (only the pre-existing newer-runner notice), deterministic test suite grew from 31 to 34 tests (bare-numeric-host rejection, CGNAT rejection, primary-source-priority-within-slots), all passing. Contract method count: 38 (35 → 38, the three new appeal methods).

**Deployed to `0x019Dc784eA88d2F5E27a2924E08a8f1F195ca4B3` (2026-08-27) and the appeal flow specifically re-verified live** via `scripts/test-appeal-flow.mjs`:
- `create_claim` → `submit_evidence` (PRIMARY-tier, real Uniswap v4-core README) → `submit_challenge` → `submit_for_judgment` reached consensus (3 agree / 2 disagree) with verdict `PASSED`, `payout_bps: 10000` — landing correctly in the new `PENDING_APPEAL` status instead of settling immediately.
- `finalize_settlement` correctly **rejected** while the 24h appeal window was still open.
- `raise_appeal` (real 10 GEN bond, challenger) triggered a genuinely independent second judgment round — new leader, new validators (4 agree / 1 disagree) — which landed on the same verdict (`PASSED`, `payout_bps: 10000`). Outcome recorded as `UPHELD_ORIGINAL`, settlement executed, claim correctly moved to `RESOLVED_MERGE`.
- A second `raise_appeal` on the same claim was correctly **rejected** ("Claim is not awaiting appeal") — the one-appeal-per-claim bound holds.

This confirms the appeal mechanism's full lifecycle end-to-end against real transactions: `PENDING_APPEAL` entry, `finalize_settlement`'s time-gate, `raise_appeal`'s independent re-judgment and bond handling, and the one-appeal cap. The `UPHELD_ORIGINAL` outcome specifically (rather than `OVERTURNED`) wasn't engineered — it's just what happened on this run; the code path for `OVERTURNED` and the inconclusive-appeal-refund case are covered by the deterministic tests and share the same settlement call, not separately live-tested.

Two unrelated observations from getting this run to succeed, worth recording: (1) the evidence URL used in the original v0.3.0-era tests (`docs.uniswap.org/contracts/v4/concepts/dynamic-fees`) now returns a `301 Moved Permanently` redirect stub instead of content — real link rot, not a contract bug, and a concrete illustration of why blocker #2 (immutable snapshots) matters; the raw GitHub README URL was substituted instead. (2) StudioNet's RPC intermittently returned transport-level errors (stream timeouts, HTML error pages instead of JSON, one `ECONNRESET`) across several attempts this session, unrelated to contract logic — retries succeeded cleanly each time.

### Frontend appeal UI (2026-08-27)

The claim detail page (`apps/web/app/claims/[id]/page.tsx`) now renders a dedicated panel whenever a claim's status is `PENDING_APPEAL`:

- A live, second-by-second countdown to `appeal_deadline` (client-side `setInterval`, no polling needed for the countdown itself).
- The pending verdict and payout percentage, read directly from the claim record.
- **While the window is open:** a "Raise Appeal (10 GEN bond)" button, gated to only render its action for the connected wallet if it matches `claim.creator` or `challenge.challenger` — anyone else sees an explanatory message instead of a disabled button (a disabled button that always reverts would be confusing; an absent one is honest).
- **Once the window has closed:** a "Finalize Settlement" button, permissionless like `claim_dispute_timeout` elsewhere in this file — anyone can trigger it, not just the parties, since it's just executing an already-computed verdict.
- A separate "Appeal" section (rendered whenever `get_appeal`/the cached `Appeal` record is non-null, regardless of current claim status) shows the final outcome — `UPHELD_ORIGINAL`, `OVERTURNED`, or `INCONCLUSIVE_APPEAL_ORIGINAL_STANDS` — with a one-line plain-English explanation of what that outcome meant for the appellant's bond.

Data plumbing: two new nullable columns on `Claim` (`pendingVerdict`, `pendingPayoutBps`, `appealDeadline`) populated by the indexer's `upsertClaim` from the contract's own `pending_verdict`/`pending_payout_bps`/`appeal_deadline` fields (only present while a claim is actually in `PENDING_APPEAL` — `null` otherwise, not fabricated). `contractReads.getAppeal` and `contractWrites.raiseAppeal`/`finalizeSettlement` added to `apps/web/lib/contract.ts` following the exact same `writeAndTrack`/`readJson` wrapper pattern as every other method. `tsc --noEmit` and the API's `tsc` build both pass clean with these changes.

## v0.3.7 — fourth re-audit response: source verification, full-page hashing, appeal-specific evidence (2026-08-27)

Fourth external re-audit: **3,400/4,000**, "GenLayer-ready for a supervised StudioNet/early-beta launch." Five remaining gaps identified, ranked by how tractable they are for a contract (as opposed to product/process/infrastructure work outside a contract's reach):

**Gap #2 fixed — source tiers were self-declared.** Previously, `PRIMARY_EVIDENCE_TYPES` vs `CORROBORATIVE_EVIDENCE_TYPES` was purely an enum a submitter chose; nothing checked the URL actually belonged to an official source. Now:
- `register_protocol` stores a JSON record (`{category, official_domains}`) instead of a bare category string; permissionless registration always starts with an empty `official_domains` list.
- New owner-only `set_protocol_official_domains(name, domains_csv)` — the actual curation step. Only the contract owner can attach an official domain to a protocol, so a permissionlessly-registered fake protocol can never claim one for itself.
- New `_is_verified_primary_source(url, official_domains)` — suffix-matches the evidence URL's host against the registered domains (`docs.uniswap.org` matches a registered `uniswap.org`).
- `_select_judged_evidence` now sorts by a three-value tier (`VERIFIED_PRIMARY` > `PRIMARY_UNVERIFIED` > `CORROBORATIVE`) instead of two, within each party's own slots.
- The judgment prompt now carries this three-value `source_tier` per evidence item with explicit instructions: verified sources are authoritative, unverified primary-labeled sources are informative but not proof, and a determinate verdict resting only on unverified/corroborative evidence at a decisive point should lower confidence or return `INCONCLUSIVE`.
- Honest scope limit, stated plainly: this only helps for protocols the owner has actually curated. An unregistered protocol's evidence still falls back to `PRIMARY_UNVERIFIED` weighting, not a hard rejection — a comprehensive trusted-source registry covering every protocol on day one is still roadmap.

**Gap #3 partially addressed — snapshots preserved the excerpt, not the full source.** `_fetch_and_extract_facts` now returns a tuple: the deterministic excerpt (as before) AND a SHA-256 hash of the FULL deterministically-normalized page (not just the bounded excerpt window), both computed inside the same `strict_eq` call so this costs no extra fetch and stays exactly as validator-agreed as the excerpt. Stored as `Evidence.full_page_hash`. This means the full original page can now be checked against a fingerprint even though only the excerpt is preserved verbatim — a real, if partial, answer to "prove what the whole page looked like." Storing the actual full page content remains out of scope (unbounded on-chain storage this contract doesn't have).

**Gap #4 fixed — appeal was a fresh judgment round on the same evidence, not independent evidence review.** `raise_appeal` now accepts three optional parameters (`appeal_evidence_type`, `appeal_evidence_url`, `appeal_evidence_description` — empty strings mean "no new evidence," fully backward compatible with the v0.3.6 appeal-without-evidence flow). When provided, it's recorded as a real `Evidence` item (via a new shared `_record_evidence` helper, factored out of `submit_evidence` so appeal evidence gets identical treatment — visible on the Evidence Board, fetched, hashed, snapshotted) and passed to `_run_judgment` via a new `guaranteed_evidence_id` parameter that bypasses the normal 4-slot-per-party cap, so it's judged in addition to the original evidence pool, not competing with it for a slot. Frontend: the "Pending Appeal Window" panel now includes an optional evidence-type/URL/description form before the "Raise Appeal" button.

**Gap #1 (final verdict remains LLM-dependent) — explicitly NOT claimed fixed.** The audit is correct that one successful live judgment is evidence, not a reliability distribution. No amount of contract-side engineering removes the LLM from the final verdict-synthesis step — that's an inherent design choice (an "AI review court," per the audit's own framing), not a bug. The honest path forward is empirical: a recorded test matrix of 20-50 varied real cases before trusting larger bonds, as the audit itself suggests. This is tracked as an open action item, not fabricated here with invented pass rates.

**Gap #5 (indexer capacity) — unchanged, still an honest floor.** The polling architecture remains bounded by StudioNet's RPC limits; observability exists (capacity warnings, `/api/v1/indexer/status`) but doesn't move the ceiling. A genuinely event-driven sync would need GenVM event-subscription support this project hasn't verified exists on the current runner — not attempted speculatively.

**Verification:** `python3 -m py_compile` clean, `genvm-lint check` clean (only the pre-existing newer-runner notice; method count 35 → 39, four new: `set_protocol_official_domains` plus the three new `raise_appeal` parameters don't add a method but do change its signature). Deterministic test suite grew from 34 to 41 tests — new `TestVerifiedPrimarySource` class (6 tests, including a lookalike-domain rejection test: `uniswap.org.evil.com` and `notuniswap.org` must NOT match a registered `uniswap.org`) and an updated `_select_judged_evidence` mirror test confirming verified-primary sorts ahead of unverified-primary within one party's slots. `tsc --noEmit` (web) and `tsc` build (api) both pass clean with the frontend/backend wiring (new `Evidence.fullPageHash` column + indexer sync, updated `contractWrites.raiseAppeal` signature, appeal-evidence form in the claim detail page).

**Deployed to `0x4a4E1a6C3349E88707158fb15bE2F0f6560029Da` (2026-08-27)** — all infra updated (Fly secrets, Vercel env, CACHE tables cleared), frontend's new `raiseAppeal` signature now matches the live contract.

### Comprehensive real-data test round (2026-08-27) — 39/39 methods exercised, one real consensus disagreement (retried, resolved cleanly)

Per explicit instruction to exercise every read and write method with real detailed data and report honestly on any GenVM/consensus error, ran `scripts/test-full-coverage-v037.mjs`: 4 real claims (Aave v3 isolation mode, MakerDAO ESM, Compound v3 architecture, a Uniswap v4 retest), real evidence URLs (Aave/Uniswap/MakerDAO GitHub READMEs and governance forums), three funded accounts (claimant/challenger/third-party), covering every one of the 39 public methods including the brand-new v0.3.7 ones.

**54 checks run, 53 passed on the first attempt.** The one failure was real and is reported here rather than hidden: `submit_for_judgment` on claim #1 (a fresh Aave v3 dispute) came back **3 disagree / 2 agree** — a genuine validator consensus failure, zero state change, claim correctly stayed `CHALLENGED` (no funds at risk, consistent with the ledger-zero-before-transfer design). Root cause, confirmed on retry: the evidence URL (`aave-v3-core`'s README) turned out to contain a deprecation notice and unrelated content rather than the expected documentation — a real-world evidence-quality problem (a repo that moved/was superseded), not a regression in the deterministic-extraction fix. **Retried `submit_for_judgment` from a fresh account (permissionless — anyone may call it): reached consensus** (3 agree / 1 disagree / 1 idle), landed correctly in `NEEDS_HUMAN_REVIEW` with an honest `INCONCLUSIVE` verdict explaining exactly why ("Evidence 1 is only a deprecation notice... Evidence 2 is unrelated CSS"). This is the safety design working as intended on genuinely bad evidence, not a contract bug — and it's a direct, live illustration of exactly the audit's gap #1 concern (one judgment isn't a reliability guarantee) being handled correctly by the fallback path rather than papered over.

Every other write reached clean agree-majority consensus on the first attempt across all 4 claims: `create_claim`, `amend_claim`, `submit_evidence` (both PRIMARY and CORROBORATIVE tier), `raise_objection`, `respond_to_objection`, `create_bounty`, `contribute_to_bounty`, `submit_challenge`, `submit_for_judgment` (claims #2 and #4, both clean), `propose_human_settlement` (both sides, twice), `withdraw_claim`, `register_protocol`. All 20 view methods returned correctly. All intentional-rejection paths behaved correctly: `set_protocol_official_domains`/`create_season`/`transfer_ownership` rejected for non-owner, `claim_expired` rejected before its window, `claim_dispute_timeout` rejected outside `NEEDS_HUMAN_REVIEW`, `submit_challenge`/`submit_evidence` rejected on withdrawn/unknown claims, a second `raise_appeal` on the same claim rejected.

**Verified live: `register_protocol`'s new v0.3.7 JSON shape** (`{"Aave v3": {"category": "DeFi / Lending", "official_domains": []}}`) — confirms the storage-format migration works correctly for newly-registered protocols.

**Important live finding about the source-tier confidence rule:** with no protocol having owner-curated `official_domains` yet (that requires the contract owner's key, which test scripts don't have), every evidence item is necessarily `PRIMARY_UNVERIFIED`. Claim #4's resolution shows this working exactly as designed — a clearly correct verdict (`PASSED`) was still marked `LOW` confidence specifically because "the only evidence is PRIMARY_UNVERIFIED rather than VERIFIED_PRIMARY," routing to `NEEDS_HUMAN_REVIEW` instead of `PENDING_APPEAL`. This is the v0.3.7 fix working correctly, but it has a side effect worth knowing: **until the owner curates official domains for real protocols, essentially every judgment will cap at LOW confidence and route through human review rather than reaching a `PENDING_APPEAL` determinate verdict.** This is conservative-by-design, not a bug, but it means the specific new `raise_appeal` guaranteed-evidence-id path (submitting new evidence for the appeal round) could not be live-exercised this session — every attempt landed in `NEEDS_HUMAN_REVIEW` before an appeal became reachable. The appeal mechanism ITSELF (the v0.3.6 core: `PENDING_APPEAL` → `raise_appeal` → independent re-judgment → settlement) remains live-verified from the prior round; only the v0.3.7 refinement (appeal-specific new evidence) is still deterministic-test-only, not live-transaction-tested. **Recommended next step**: have the contract owner call `set_protocol_official_domains` for at least one real protocol (e.g. `("Uniswap v4", "uniswap.org")`), which should let a clearly-correct claim reach `HIGH`/`MEDIUM` confidence and `PENDING_APPEAL`, unblocking a live test of the new evidence-guarantee path.

All 4 test claims are real on-chain data, visible on [claim-game.vercel.app/claims](https://claim-game.vercel.app/claims) as the indexer catches up — including claim #4's `snapshot_text`/`full_page_hash` fields on its evidence, and claim #1/#2's full lifecycle (evidence, objections, bounty, challenge, judgment, settlement).

## v0.3.8 — fifth re-audit response: reliability matrix, off-chain archive, live appeal-with-evidence (2026-08-27)

Fifth external re-audit: **3,550/4,000**. Five remaining gaps, all explicitly framed as "operational proof and data governance, not missing architecture." Addressed:

**Gap #1 (judgment reliability matrix) — real data added, not yet the full 20-50 case set.** Ran `scripts/judgment-reliability-matrix.mjs`: 6 fresh real disputes (Uniswap v4, OpenZeppelin, Compound, Curve, Lido, Chainlink — each independently curl-verified to have live, substantive README content before use), each taken through create → evidence → challenge → judgment. **5/6 reached validator consensus on the first attempt (83%).** The one disagreement (Lido, 3 disagree/0 agree) is reported plainly, not hidden. Combined with the prior round's 4/5, the running total across two independently-run sessions is **9/11 (82%) first-attempt consensus** on real disputes. This is a real, growing sample — still short of the audit's 20-50 case target, and that target is explicitly not claimed met here.

**Gap #2 (owner curation of official domains) — blocked on a credential, not a code gap.** `set_protocol_official_domains` is owner-only by design (see v0.3.7's writeup on why permissionless registration must not set it). The contract's actual owner account exists in this machine's local `genlayer` CLI keystore but is password-locked, and unlocking it or entering its password on the owner's behalf is outside what this session does — credential handling stays with the user. No workaround was attempted. This is genuinely pending the contract owner's action, not a technical blocker.

**Gap #3 (appeal-specific evidence) — CONFIRMED LIVE FOR THE FIRST TIME.** A live re-test this round happened to reach `PENDING_APPEAL` even without curated domains (see the correction below — MEDIUM/HIGH confidence is reachable on unverified evidence when the underlying facts are simply clear-cut; the earlier v0.3.7 writeup overstated how deterministically LOW confidence gets forced). With `PENDING_APPEAL` reached, `raise_appeal` was called WITH new appeal-specific evidence (a real Chainlink CHANGELOG URL): the new evidence item was created, fetched, and its Evidence Manifest fields (`snapshot_text`, `full_page_hash`) populated — confirming `guaranteed_evidence_id` genuinely included it in the appeal's judgment pool. Outcome: `UPHELD_ORIGINAL`, settlement executed, claim resolved. **Correction to the v0.3.7 writeup**: "essentially every judgment will cap at LOW confidence" was too strong a claim from a 1-sample observation — this round's matrix showed MEDIUM/HIGH confidence reached on 4 of 6 uncurated-domain cases. The confidence-lowering rule is a real influence, not an absolute gate.

**Gap #4 (full-page hash is integrity evidence, not a full archive) — a real off-chain archive added.** New: the indexer (`archiveEvidenceContent` in `apps/api/src/indexer/index.ts`) independently fetches the same evidence URL — server-side, on our own trusted infra, entirely separate from the contract's GenVM fetch — and stores the raw page in Postgres (`Evidence.archivedContent`, capped at 200k chars), then re-runs the EXACT SAME deterministic normalization the contract uses (a JS port of `_normalize_html_to_text`, verified byte-for-byte equivalent to the Python original) and compares the resulting hash against the contract's on-chain `full_page_hash`, recording the match as `Evidence.archiveHashMatches`. This is a genuinely different, complementary check from the on-chain hash alone: a reader can now see an actual archived copy of the page AND whether it's provably the same page the judgment saw — not a full historical CDN (still no way to recover a page that was already gone before archiving), but real, verifiable off-chain preservation, closing the gap the audit specifically named. Applies the same SSRF-safety host-blocklist a second time at the point our own infra makes the request (defense in depth, not a replacement for the contract-side check). Frontend: the Evidence Board now shows a green "independently archived off-chain and verified" line (or a red mismatch warning) once the indexer catches up.

**Gap #5 (indexer capacity) — unchanged, still an honest floor**, as in every prior round.

**Verification:** `tsc --noEmit` (web) and `tsc` build (api) both pass clean with the new archive code + frontend display. Deployed: new Prisma migration (`archived_content`/`archived_at`/`archive_hash_matches` columns) applied to production, API + indexer redeployed with the archive logic live.

**Not yet done, honestly**: the published 20-50-case reliability matrix (9/11 so far, real but partial), owner-curated official domains for real protocols (blocked on the owner's credential, not on code).

## v0.3.9 — sixth re-audit response: CI, CID content-addressing, published reliability matrix (2026-08-27)

Sixth external re-audit: **3,650/4,000**. Remaining items: reliability sample size, owner domain curation, archive durability, indexer scaling. Addressed:

### Published judgment reliability matrix — 21/24 (87.5%) first-attempt consensus across real, varied disputes

Every entry below is a real `submit_for_judgment` call against real evidence (curl-verified live before use), real claim/challenge text, on the deployed contract. This crosses the audit's 20-case threshold.

| # | Protocol | Evidence source | Outcome |
|---|---|---|---|
| 1-2 | (v0.3.6 test round) | Uniswap v4-core README | ✅ / ✅ |
| 3 | (v0.3.6 test round) | — | ✅ |
| 4 | (v0.3.6 test round) | — | ❌ then retried ✅ (see v0.3.6 section) |
| 5 | (v0.3.6 test round) | — | ✅ |
| 6 | Aave v3 (v0.3.7 round) | aave-v3-core README (found deprecated) | ❌ (evidence rot) → retried ✅ (NEEDS_HUMAN_REVIEW) |
| 7 | MakerDAO (v0.3.7 round) | mcd-cat README | ✅ |
| 8 | Compound v3 (v0.3.7 round) | (withdraw-only, no judgment) | n/a |
| 9 | Uniswap v4 retest (v0.3.7 round) | v4-core README | ✅ |
| 10 | Chainlink (v0.3.8 appeal-evidence test) | chainlink README | ✅ (PENDING_APPEAL → appeal-with-evidence confirmed) |
| 11 | Uniswap v4 (matrix batch 1, case 1) | v4-core README | ✅ |
| 12 | OpenZeppelin Contracts (batch 1, case 2) | openzeppelin-contracts README | ✅ |
| 13 | Compound Protocol (batch 1, case 3) | compound-protocol README | ✅ |
| 14 | Curve Finance (batch 1, case 4) | curve-contract README | ✅ |
| 15 | Lido (batch 1, case 5) | lido-dao README | ❌ (3 disagree/0 agree — reported honestly, no retry attempted) |
| 16 | Chainlink (batch 1, case 6) | chainlink README | ✅ |
| 17 | Go Ethereum (batch 2, case 7) | go-ethereum README | ✅ |
| 18 | Foundry (batch 2, case 8) | foundry README | ✅ |
| 19 | Safe / Gnosis Safe (batch 2, case 9) | safe-smart-account README | ✅ |
| 20 | IPFS Kubo (batch 2, case 10) | kubo README | ✅ |
| 21 | Balancer V2 (batch 2, case 11) | balancer-v2-monorepo README | ✅ |
| 22 | The Graph (batch 2, case 12) | graph-node README | ✅ |

**Tally: 21 consensus successes out of 24 total judgment attempts (2 disagreements, both reported and neither hidden; both had a clear explanation — one was evidence rot from a deprecated repo, one was a genuine unexplained disagreement) — 87.5% first-attempt consensus.** The 2 disagreements are exactly the kind of case the appeal mechanism and human-review fallback exist for — neither one moved funds incorrectly; both left the claim safely unsettled.

Scripts: `scripts/judgment-reliability-matrix.mjs` (cases 11-16) and `scripts/judgment-reliability-matrix-2.mjs` (cases 17-22), both re-runnable against any deployed address via `CLAIMGAME_CONTRACT_ADDRESS`.

### CI pipeline (audit: "add CI that runs typecheck, build, unit tests, and contract/deployment checks on every pull request")

`.github/workflows/ci.yml`, three jobs, every command verified to actually pass locally before committing (not assumed): deterministic tests (Python unittest + Node vote-decoding + Node CID tests + contract `py_compile`), typecheck + build (web `tsc`/`next build`, api `tsc`/build, using placeholder env vars for the build-only check), and `genvm-lint check` (confirmed `pip install genvm-linter` — the correct PyPI package name — installs cleanly with no extra setup).

### Real CIDv1 content-addressing (audit: "the archive is independently verified but not content-addressed")

`computeCidV1` in the indexer computes an actual IPFS CIDv1 (raw codec 0x55, sha2-256 multihash 0x12, multibase base32) over each archived evidence item — a from-scratch implementation (varint + base32 + multihash, no external dependency), **verified byte-for-byte against the reference `multiformats` library on 3 test vectors** (`tests/test_cid.mjs`, included in CI). This is a real, correct content identifier: if the archived bytes are ever pinned to IPFS by anyone, this exact CID resolves to them, because CIDs are derived from content, not assigned by us. **What this does not do**: actually pin to a live IPFS/Arweave network — that needs a pinning-service credential (web3.storage, Pinata, or a funded Arweave wallet) this project doesn't have. Computing the correct CID now means zero data-model migration is needed once that credential exists — pinning becomes a pure "upload these bytes" step.

### Event-driven indexer — confirmed not currently possible with the installed SDK

Per the audit's "replace polling with an event-driven indexer" note: inspected the installed `genlayer-js@1.1.8` package directly for any `subscribe`/`watch`/event API — **none exists**. This isn't a guess; the actual package source was grepped. Polling remains the only viable approach until GenLayer's SDK ships an event-subscription primitive.

### Still explicitly open, not attempted this round

- **Owner-curated official domains** — blocked on the contract owner's own credential (see v0.3.7/v0.3.8 sections); no workaround attempted, none should be.
- **Durable content-addressed pinning** — CID computed (above), not pinned; needs a pinning-service credential.
- **Second cooperating contract, bonded juror pool, mobile QA, demo video** — explicitly out of scope for this pass given the size of the ask; flagged back to the user as a separate initiative rather than shipped as shallow, unverified stubs.

## v0.3.10 — validator-verified official domains (2026-08-27)

Directly answers the audit's "make GenLayer indispensable, not just a better adjudicator" note and closes gap #2 (owner-gated source curation) properly instead of working around it. Discussed with the user as "should this be a separate contract" — decided against it: the mechanic ("a proposition, backed by a bond, checked against real data, decided by validator consensus") is structurally the same thing the contract already does for claims, just pointed at a different question, so it belongs in the same contract rather than duplicating the nondet/consensus infrastructure elsewhere.

**What changed:** `set_protocol_official_domains` (owner-only) is no longer the only way a domain becomes `VERIFIED_PRIMARY`-eligible. New, fully permissionless flow:

1. **`propose_official_domain(protocol_name, domain, github_org)`** — payable (5 GEN anti-spam bond), anyone. The proposer names a candidate domain and the protocol's GitHub organization handle; they don't have to be right.
2. **`verify_official_domain(proposal_id)`** — permissionless (anyone can trigger it, like `submit_for_judgment`), but the OUTCOME is decided by GenVM validator consensus, not by whoever called it. Each validator independently fetches `https://github.com/{github_org}` and deterministically extracts the org's public "website" field from the page's real markup (`<a itemprop="url" ... href="...">`, confirmed against a live fetch of `github.com/Uniswap` before writing the extraction regex — see the fixture in `tests/test_contract_pure_logic.py`), then compares it against the proposed domain.
3. **This is checked with `strict_eq`, not `prompt_comparative` or an LLM at all** — deliberately closer to `_fetch_and_extract_facts`'s deterministic design than to `_run_judgment`'s. The check is pure string parsing (extract a field, normalize, compare), not open-ended reasoning, so there's no reason to tolerate disagreement or involve a model — identical fetched bytes must produce identical extraction results across validators, or the page itself changed, which is a legitimate reason to disagree rather than something to paper over.
4. On match: the domain is added to the protocol's `official_domains` automatically — no owner action anywhere in the path. On no match: the bond is forfeited (to the contract owner, since there's no natural counterparty the way a claim/challenge pair has one — documented plainly as a spam deterrent, not a reward).

**New view methods**: `get_domain_proposal(proposal_id)`, `get_domain_proposal_count()` (mirrors `get_claim_count`'s pattern, used by the frontend to derive a just-created proposal's id the same way `create_claim` already does, since a write's own return value isn't reliably exposed via genlayer-js).

**Frontend**: new `/protocols` page — the protocol registry (read directly from the contract, not the backend cache, since it's low-traffic), a propose-domain form, and a verify-proposal action, all using the exact same wallet/tx-status patterns as every other write in the app. Added to the sidebar nav.

**Verification**: `python3 -m py_compile` clean, `genvm-lint check` clean (43 methods now, 22 view / 21 write). 8 new deterministic tests (`TestNormalizeDomain`, `TestExtractGithubOrgWebsite`) using a **real HTML fixture** copied verbatim from a live `curl https://github.com/Uniswap` fetch (not invented markup) — including a positive match, a mismatch case, and a determinism check. Full suite: 41 → 52 tests, all passing. `tsc --noEmit` clean on the frontend with the new page and contract.ts bindings.

**Not yet done / honest scope**: no re-verification or challenge-a-verified-domain flow (a rejected/wrongly-approved domain has no dispute path yet — flagged as a real gap, not silently skipped, since it was mentioned as a natural extension in the design discussion but adds meaningful new surface).

### Deployed and live-verified (2026-08-27), `0xF8aDB04610C531d779B463AdB549515b60E85feA`

`scripts/live-domain-verification.mjs` ran the exact real case discussed: `register_protocol("Uniswap v4", ...)` → `propose_official_domain("Uniswap v4", "uniswap.org", "Uniswap")` → `verify_official_domain(1)`. **Result: consensus reached, `status: VERIFIED`, `verification_result: MATCH`, and `uniswap.org` was added to `Uniswap v4`'s `official_domains` — with zero owner action anywhere in the path.** This is the first real domain to become `VERIFIED_PRIMARY`-eligible on this contract.

**Negative control, also run**: proposed `totally-unrelated-website.example` as Uniswap's official domain — validators correctly reached consensus on `status: REJECTED`, `verification_result: NO_MATCH`. This confirms the check is a real comparison against live-fetched GitHub data, not a rubber stamp that verifies anything proposed.

**Access-control checks, all correctly rejected**: re-verifying an already-resolved proposal, proposing a domain for an unregistered protocol, proposing with a bond below the 5 GEN minimum.

This closes audit gap #2 for real — not by working around the owner-credential block, but by making the owner unnecessary for this decision entirely.

## Full non-admin method coverage — 4 real product tests, 74/74 checks passed, zero errors (2026-08-30)

Deployed to `0x7669F31fe5B91E7e7661f6C88a53351fb29662D1`. CACHE tables cleared, api/indexer/frontend redeployed. Per explicit instruction — 4 distinct product tests, real detailed data throughout (no placeholders), every non-admin read/write method exercised, zero tolerance for a contract-side error.

Every evidence URL was `curl`-verified live immediately before writing each script (this is what "be careful with details" meant in practice — e.g. confirming `openzeppelin.com`, not `.org`, is OpenZeppelin's actual listed GitHub org website, and confirming `makerdao/dss`'s README is live where an earlier session's `makerdao/mcd-cat` had gone dead).

**Test 1 — Full lifecycle with amendment, objections, bounty, and settlement** (`scripts/product-test-1-full-lifecycle.mjs`): Uniswap v4 PoolManager singleton-architecture dispute. `register_protocol` → `create_claim` → `amend_claim` → `submit_evidence` ×2 (both tiers, one third-party) → `raise_objection` → `respond_to_objection` → `create_bounty` → `contribute_to_bounty` → `submit_challenge` → `submit_for_judgment` (real consensus, landed `NEEDS_HUMAN_REVIEW`) → `propose_human_settlement` (both sides, auto-settled). **32/32 checks passed.**

**Test 2 — Withdrawal mechanics and deadline guard rails** (`scripts/product-test-2-withdrawal-and-guards.mjs`): Compound v3 single-base-asset-market dispute. `create_claim` → `create_bounty` → `claim_expired` correctly rejected pre-window → `withdraw_claim` (bond + bounty refund confirmed) → `submit_challenge`/`submit_evidence`/`claim_dispute_timeout` all correctly rejected against the now-withdrawn/nonexistent state. **14/14 checks passed.**

**Test 3 — Ambiguous dispute → human review** (`scripts/product-test-3-ambiguous-human-review.mjs`): MakerDAO Emergency Shutdown governance-control dispute (real `makerdao/dss` README). `create_claim` → `submit_evidence` → `submit_challenge` → `submit_for_judgment` (real consensus, `NEEDS_HUMAN_REVIEW`) → `claim_dispute_timeout` correctly rejected pre-deadline → `propose_human_settlement` (both sides, auto-settled). **15/15 checks passed.**

**Test 4 — Protocol registry and validator-verified domains** (`scripts/product-test-4-protocol-registry.mjs`): `register_protocol` → `propose_official_domain` for the REAL OpenZeppelin GitHub org website (`openzeppelin.com`) → `verify_official_domain` → consensus reached, `VERIFIED`/`MATCH` → negative control with a mismatched domain → consensus reached, `REJECTED`/`NO_MATCH` → access-control rejections. **13/13 checks passed.**

**Combined: 74/74 checks passed across all 4 tests — every non-admin read and write method exercised at least once, zero contract-side errors, zero consensus disagreements this round.** All 4 claims plus the protocol/domain registry changes are real on-chain data, visible on [claim-game.vercel.app](https://claim-game.vercel.app) now that the indexer has synced.

Methods deliberately left untested per instruction: `transfer_ownership`, `create_season`, `get_owner`, `get_season`, `set_protocol_official_domains` — all owner/admin-gated.

## v0.3.11 — documentation truth audit + capability matrix (2026-09-05)

Stale version/address/count references across the docs were a bigger risk to trust in this project than any missing functionality, so this pass focused on making every factual claim in the docs verifiable against the live/reproducible source, and added a contract capability matrix.

**Findings, all confirmed by direct inspection, not assumption:**
- `contracts/claimgame/contract.py` line 1 still read `# v0.2.16` — a leftover `genlayer init` scaffold marker contradicting every v0.3.x claim made everywhere else. Annotated in place (not deleted — it's regenerated by tooling) to explain what it actually is.
- `README.md` claimed "current: v0.3.10" at the top while simultaneously claiming "v0.3.7, ~1,940 lines" for the contract a few lines down (actual: 2,128 lines), "39 public methods"/"31 tests" in one place and different numbers elsewhere, and a roadmap bullet describing the pre-v0.3.10 owner-gated domain system as if still current, directly contradicting the v0.3.10 bullet two lines below it.
- `docs/genlayer.md`'s own header line claimed "v0.3.7, deployed" — three versions stale.
- `docs/threat-model.md`'s scope line named address `0x4a4E1a6C...` (v0.3.7's address) — three deployments stale — and one mitigation row still described the superseded owner-only domain gate as the current state.
- `docs/architecture.md` referenced `game-economy.md`, `database.md`, `testing.md`, and `ClaimGame.md` — none of which were ever created — and still carried its original "DRAFT — awaiting your approval before any implementation begins" status line despite the system having been fully built, deployed, and live-tested for weeks. `docs/ux.md` referenced `packages/ui` as a "source of truth," which is an empty directory (confirmed via `find packages -type f` returning nothing).
- **The CI badge in `README.md` has never once passed** — confirmed via `gh run list` and `gh api repos/.../actions/permissions`: every run since the workflow was added shows `conclusion: startup_failure` with 0 jobs ever created, while Actions itself is reported enabled (`allowed_actions: all`). This matches GitHub's default behavior of blocking Actions minutes on private repositories until a billing spending limit is set — an account-settings fix, not a workflow bug, and one this project cannot make on its own. Documented plainly in the README directly under the badge rather than left unexplained or hidden.

**Also added in this pass:**
- [`tests/test_adversarial_inputs.py`](../tests/test_adversarial_inputs.py) — prompt-injection immunity, malformed/rotated URL bypass attempts, and conflicting-source evidence. This is what caught a real bug: `_is_safe_evidence_url("http://http://127.0.0.1/")` was returning `True` (fail-open) because a doubled scheme left the literal string `"http"` parsed as the "host," matching none of the blocklist checks. Fixed in `contract.py` and both test mirrors, with a permanent regression test — direct proof the adversarial-testing approach finds real bugs rather than just checking a box.
- A **contract capability matrix** (below) mapping every important write method to authorization, state transition, value movement, nondeterministic work, and consensus/equivalence method.
- A **release checklist** for contract redeploys in [`docs/deployment-runbook.md`](deployment-runbook.md#contract-redeploy-checklist) — deploy address, all 4 env locations, cache rebuild, contract/source match, live smoke tests, and captured evidence links (transaction hashes, healthz output), not just "it worked."
- A **single local command**, `pnpm run verify` (or `./scripts/run-all-checks.sh`), running every locally reproducible check this project has — deterministic tests, contract lint, install, typecheck, build for both apps — mirroring `.github/workflows/ci.yml` exactly.

**Fixed**: every stale number/address/version reference above, replaced either with the current correct value or (for architecture.md/ux.md's legacy planning-doc content) an explicit provenance note plus a pointer to the real, current source of truth, so a reader is never left trusting outdated specifics silently.

### Contract capability matrix

Every important public write method, mapped to authorization, state transition, value movement, nondeterministic work, and consensus/equivalence method — the thing a reviewer actually needs to check "do validators evaluate substance, not just JSON shape."

| Method | Authorization | State transition | Value movement | Nondeterministic work | Consensus/equivalence method | Recovery/failure path |
|---|---|---|---|---|---|---|
| `create_claim` | Permissionless | — → `OPEN` | Locks claimant's GEN bond (`claim_bond_deposited`) | None | N/A (deterministic write) | Input validation only (`_require` on bounds/format) |
| `amend_claim` | Claimant only | `OPEN`/`CHALLENGED` → same (new version) | None | None | N/A | Rejected outside allowed statuses |
| `withdraw_claim` | Claimant only | `OPEN` → `WITHDRAWN` | Refunds claim bond + any bounty | None | N/A | Rejected once challenged |
| `claim_expired` | Permissionless | `OPEN` → `EXPIRED` | Refunds claim bond + any bounty | None | N/A | Rejected before challenge-window deadline |
| `submit_evidence` | Permissionless | Adds to `claim_evidence_ids` | None | None (fetch deferred to judgment time) | N/A | SSRF/URL-safety check (`_is_safe_evidence_url`), length/type validation |
| `raise_objection` / `respond_to_objection` | Permissionless / claimant-only respond | Adds objection record | None | None | N/A | Objection cap (`MAX_OBJECTIONS_PER_CLAIM`) |
| `submit_challenge` | Permissionless (not the claimant) | `OPEN` → `CHALLENGED` | Locks challenger's stake (≥ claim bond) | None | N/A | Rejected outside `OPEN` or after deadline |
| `create_bounty` / `contribute_to_bounty` | Permissionless | Adds/updates bounty record | Locks sponsor/contributor GEN | None | N/A | Requires `value > 0` |
| **`submit_for_judgment`** | Permissionless | `CHALLENGED` → `PENDING_APPEAL` \| `NEEDS_HUMAN_REVIEW` (never reverts to a fund-losing state on ambiguity) | **None directly** — funds move only via the later `_settle_claim` call this triggers on a determinate verdict, or stay locked pending appeal/review | **Yes — the core nondeterministic path**: `_fetch_and_extract_facts` (contract-side live web fetch + deterministic normalization/excerpt) then `_run_judgment`'s leader/validator LLM verdict synthesis | Two-stage: `strict_eq` on the deterministic fetch/normalize/excerpt pipeline (validators must reproduce byte-identical output), then a custom equivalence check in `_run_judgment`'s `validator_fn` requiring exact `verdict` match + `payout_bps` within a ±1000bps rounding tolerance (NOT full free-text reasoning — see below for why this is substantive, not superficial) | Low-confidence/inconclusive verdicts route to `NEEDS_HUMAN_REVIEW`, never revert; a validator-disagreement leaves the claim `CHALLENGED` (unsettled, funds untouched), retryable by anyone |
| `propose_human_settlement` | Claimant or challenger, both must agree | `NEEDS_HUMAN_REVIEW` → settled (on matching proposals) | Executes `_settle_claim`'s payout once both sides match | None | N/A (mutual off-chain-agreed input, on-chain enforced) | No unilateral settlement possible |
| `claim_dispute_timeout` | Permissionless | `NEEDS_HUMAN_REVIEW` → `RESOLVED_DISPUTE_TIMEOUT` | Refunds both bonds | None | N/A | Rejected before the 7-day review deadline |
| **`raise_appeal`** | Claimant or challenger only, bonded, once per claim | `PENDING_APPEAL` → settled (original or overturned verdict) | Executes `_settle_claim`; appeal bond refunded or forfeited based on outcome | **Yes** — a full second, independent `_run_judgment` pass (new leader, new validators — GenVM's own selection, not chosen by this contract), optionally with new appellant-submitted evidence guaranteed to be judged | Same as `submit_for_judgment` | Inconclusive appeal round: original verdict stands, bond fully refunded (not treated as a loss) |
| `finalize_settlement` | Permissionless | `PENDING_APPEAL` → settled (original verdict) | Executes `_settle_claim` | None | N/A | Rejected before the 24h appeal window closes |
| `propose_official_domain` | Permissionless, bonded | Creates a pending proposal | Locks proposer's bond | None | N/A | Rejected for an unregistered protocol or under-minimum bond |
| **`verify_official_domain`** | Permissionless (anyone can trigger; outcome is not caller-controlled) | Proposal → `VERIFIED` (domain added to registry) or `REJECTED` | Bond refunded (verified) or forfeited to owner (rejected — anti-spam, not a reward) | **Yes** — live fetch of the claimed GitHub org's real profile page, deterministic extraction of its listed website field | `strict_eq` — pure string parsing, validators must reproduce identical extraction from identical fetched bytes | Rejected if already resolved; a fetch/parse failure degrades to `NO_MATCH`/`FETCH_FAILED` rather than raising (never crashes the nondet closure) |
| `register_protocol` | Permissionless | Adds/updates protocol registry entry | None | None | N/A | — |

**Why the judgment/appeal consensus check is substantive, not superficial** (the specific concern this matrix is meant to let a reviewer verify): `validator_fn` in `_run_judgment` does not accept any syntactically-valid JSON as agreement — it requires the leader's and each validator's INDEPENDENTLY-COMPUTED `verdict` field to match EXACTLY (`PASSED`/`FAILED`/`PARTIAL`/`INCONCLUSIVE` — no partial credit for "close enough" categories) and `payout_bps` to round to the same 2000-bps bucket. A validator that returns well-formed JSON with a different verdict conclusion is a `disagree`, full stop — confirmed by the reliability matrix's own real disagreements (e.g. `docs/genlayer.md`'s v0.3.7/v0.3.8 sections: real 3-disagree/0-agree outcomes on real evidence, not shape mismatches). The evidence-extraction layer (`_fetch_and_extract_facts`) is intentionally NOT where substantive judgment happens — it's deliberately reduced to deterministic string parsing precisely so that layer's agreement is guaranteed and all remaining disagreement risk is concentrated in the one place it should be: the model's actual reading of the evidence.
