# CLAIMGAME — GenLayer Intelligent Contract

File: [`contracts/claimgame/contract.py`](../contracts/claimgame/contract.py) — one contract, ~1,740 lines (v0.3.6), syntax-verified with `python3 -m py_compile` and `genvm-lint check`.

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
