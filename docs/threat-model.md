# CLAIMGAME — Threat Model

Scope: the deployed system as of v0.3.11 (contract `0x4F3789881344cB7a5176b19eEADBAc3586Bb2EA6` on GenLayer StudioNet, Fly.io backend, Vercel frontend). This is a working threat model reflecting what has actually been built and tested, not a template — every mitigation cited below exists in the codebase today, and every open item is genuinely open, not a formality. **This address changes on every contract redeploy** — verify it still matches `curl -s https://claimgame-api.fly.dev/healthz` before trusting anything below as current.

## 1. Assets

- **User funds**: GEN bonded on claims, challenges, appeals, and bounties, held in contract storage until settlement.
- **Verdict integrity**: the judgment result that determines who receives escrowed funds.
- **Evidence integrity**: the record of what the contract actually fetched and judged.
- **Account/session integrity**: wallet-linked backend sessions (JWT + refresh token).

## 2. Threats and mitigations (by attacker goal)

### 2.1 Steal or misdirect escrowed GEN

| Threat | Mitigation | Status |
|---|---|---|
| Double-spend / re-entrant withdrawal | Ledger-zero-before-transfer pattern (`_settle_claim`): both ledger fields are read into locals, zeroed, persisted, THEN `_send_gen` is called — a repeated call finds a zeroed ledger and is rejected before any second transfer. Single `_send_gen` choke point audited to be the only place GEN leaves the contract. | Mitigated |
| Forge a verdict without going through consensus | All state-changing paths (`_apply_verdict`, `_settle_claim`) are only reachable from `submit_for_judgment`/`raise_appeal`/`finalize_settlement`/`propose_human_settlement`/`claim_dispute_timeout` — no direct "set verdict" method exists. | Mitigated by design |
| Claim someone else's role (impersonate claimant/challenger) | Every write checks `gl.message.sender_address` against the stored `creator`/`challenger` field, not a caller-supplied identity string. | Mitigated |
| Bounty funds get stuck with no exit | `_refund_bounty_if_any` fires on every non-judgment terminal path (withdraw, expire, dispute-timeout). | Mitigated |

### 2.2 Manipulate the judgment outcome

| Threat | Mitigation | Status |
|---|---|---|
| Prompt injection via evidence content | The judgment prompt explicitly instructs the model to treat fetched evidence as untrusted data, not instructions, and to flag (not obey) any embedded directive. | Mitigated, not provably unbreakable — inherent LLM-prompt risk, see §4 |
| Self-declared evidence tier ("I say this is official docs") | v0.3.10: source tier requires the URL host to match a validator-verified `official_domains` list (`VERIFIED_PRIMARY`) or is downgraded to `PRIMARY_UNVERIFIED`, weighted lower in the prompt. Any account can `propose_official_domain`; `verify_official_domain` is decided by GenVM consensus checking the protocol's real GitHub org metadata, not an owner decision. | Mitigated and live-verified — `uniswap.org` and `openzeppelin.com` both confirmed live via real consensus, plus a negative-control mismatched domain correctly rejected (see docs/genlayer.md's v0.3.10 sections) |
| Evidence-slot flooding (crowd out the other party's evidence) | Per-party evidence slots (`MAX_JUDGED_EVIDENCE_PER_PARTY`), sorted by verified-tier first within each party's own allowance — neither party can consume the other's slots. | Mitigated |
| Cross-claim evidence citation (hallucinated/copy-pasted id) | `_apply_verdict` checks every cited id against `claim_evidence_ids` for THIS claim before honoring it. | Mitigated |
| Judgment never resolves (validator disagreement locks funds) | Ledger is never zeroed until settlement succeeds — a disagreement leaves the claim `CHALLENGED`/unsettled with funds untouched, retryable by anyone (permissionless `submit_for_judgment`). Confirmed live: a real disagreement this session left funds safe and a retry succeeded. | Mitigated (liveness, not correctness) |
| SSRF via evidence URL (contract's own fetch as an attack vector) | `_is_safe_evidence_url` blocks non-http(s) schemes, loopback/private/CGNAT ranges, numeric-host obfuscation, bracketed IPv6. Applied a second time independently by the indexer's own archive fetch. | Mitigated as a floor — real protection needs GenVM validator-node network-egress controls this project doesn't operate |

### 2.3 Corrupt or destroy evidence provenance

| Threat | Mitigation | Status |
|---|---|---|
| Evidence page changes after judgment, no way to detect it | `full_page_hash` (SHA-256 of the full normalized page, agreed via `strict_eq` across validators) recorded at judgment time. | Mitigated for detection |
| No way to see what the page actually looked like | v0.3.8: indexer independently archives the raw page off-chain, verified against the on-chain hash. v0.3.9: a real CIDv1 is computed over the archive (not yet pinned to a durable network). | Partially mitigated — pinning needs a credential this project doesn't have |
| Evidence page is gone before anyone archives it | No mitigation — if the page is gone before both the contract's judgment-time fetch AND the indexer's archive fetch, the content is genuinely lost except for the preserved excerpt + hash. | Open, disclosed |

### 2.4 Attack the off-chain infrastructure

| Threat | Mitigation | Status |
|---|---|---|
| Backend/indexer diverges from on-chain truth | Indexer is the ONLY writer to CACHE tables; no API route writes them directly. A stale/wrong cache is detectable via `/api/v1/indexer/status` (staleness threshold), and the frontend falls back to direct contract reads both for a user's own just-submitted claim (claim detail page) and for reconciling the Hunt Board list against `get_claim_count` (added 2026-09-05). | Mitigated for detectability |
| Session/auth bypass | Wallet-based sign-in (nonce + signature, no passwords), httpOnly cookie, `SameSite=None; Secure` for the cross-origin frontend/backend split, refresh-token rotation. | Mitigated |
| Indexer used as an SSRF proxy via its new archive-fetch feature | Same host-blocklist check applied independently at the point the indexer makes the request (defense in depth on top of the contract-level check evidence already had to pass). | Mitigated as a floor |
| DB credential/secret leakage | All secrets are Fly/Vercel-managed env vars, never committed; `.env.local`/`.env` gitignored; verified no secrets in any commit this project's history. | Mitigated |

## 3. Explicitly out of scope / accepted risk

- **GenVM validator infrastructure itself** (node compromise, collusion, network-layer attacks on validators) — this project deploys a contract onto GenLayer StudioNet; it does not operate or secure the validator network.
- **StudioNet availability** — the whole system's liveness depends on StudioNet's uptime and rate limits, which this project cannot control, only work around (throttling, retries).
- **LLM judgment being "wrong" in a way that's still internally consistent** (i.e., the model reasons plausibly but reaches a verdict a human disagrees with) — mitigated by the appeal mechanism (independent re-judgment) and human-review fallback, not eliminated. This is the core, currently-open item tracked as "judgment reliability" across every audit round in `docs/genlayer.md`.

## 4. Known open items (tracked, not silently accepted)

1. **Judgment reliability sample size** — 21/24 (87.5%) first-attempt consensus published (see `docs/genlayer.md`), still below a 20-50 case target for very large bonds.
2. **Source verification no longer requires owner action (fixed in v0.3.10)** — `propose_official_domain`/`verify_official_domain` replaced the owner-gated path with validator consensus; `set_protocol_official_domains` still exists as an owner-only shortcut but is no longer the only way to reach `VERIFIED_PRIMARY`.
3. **Archive durability** — off-chain archive is database-hosted, not yet pinned to IPFS/Arweave (needs a pinning-service credential).
4. **Indexer scaling** — polling-bound, no event-driven alternative exists in the current `genlayer-js` SDK (confirmed by inspecting the installed package for any subscribe/watch API — none found).
5. **Prompt-injection resistance is instructional, not structural** — the contract tells the model to treat evidence as data, but nothing prevents a sufficiently clever injection from partially succeeding; this is an open research problem for LLM-based judgment generally, not unique to this contract.
