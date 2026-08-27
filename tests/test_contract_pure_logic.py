"""
Deterministic invariant tests for CLAIMGAME's contract logic.

Audit finding #5: this directory was empty. The live StudioNet scripts in
scripts/*.mjs are real, valuable integration tests, but they mutate a
shared testnet, cost real GEN, and take minutes per run — not something
CI can run on every commit. This file covers what CAN be tested
deterministically, with zero network dependency and zero cost: the PURE
functions in contracts/claimgame/contract.py (escrow split math, evidence
URL safety policy, provenance hashing, evidence-slot selection).

IMPORTANT — why these are duplicated, not imported: contract.py starts
with `from genlayer import *`, and the `genlayer` package only exists
inside GenVM's execution sandbox. It cannot be imported in a normal Python
environment, so these functions are re-implemented here to match
contract.py's logic exactly. Every function below names the exact
contract.py function it mirrors — when contract.py's implementation
changes, this file must be updated in the same commit, and a code review
should treat a diff to one without the other as suspicious.

Run: python3 -m unittest discover -s tests -v
No dependencies beyond the Python 3 standard library.
"""

import hashlib
import re
import unittest


# ============================================================================
# Mirrors contract.py's _is_safe_evidence_url (SSRF-floor URL policy)
# ============================================================================

_BLOCKED_HOST_PREFIXES = (
    "localhost",
    "127.",
    "0.",
    "10.",
    "169.254.",
    "192.168.",
    "::1",
    "0x",
)
_BLOCKED_HOST_EXACT = ("metadata.google.internal",)


def is_safe_evidence_url(url: str) -> bool:
    lowered = url.strip().lower()
    if not (lowered.startswith("http://") or lowered.startswith("https://")):
        return False
    rest = lowered.split("://", 1)[1]
    host_and_maybe_port = rest.split("/", 1)[0].split("@")[-1]
    if host_and_maybe_port.startswith("["):
        return False  # bracketed IPv6 literal — reject outright
    host = host_and_maybe_port.split(":", 1)[0]
    if not host:
        return False
    if host in _BLOCKED_HOST_EXACT:
        return False
    for prefix in _BLOCKED_HOST_PREFIXES:
        if host.startswith(prefix):
            return False
    if host.replace(".", "").isdigit() and "." not in host:
        return False  # bare decimal/octal numeric host, e.g. "2130706433"
    if host.startswith("172."):
        parts = host.split(".")
        if len(parts) >= 2 and parts[1].isdigit() and 16 <= int(parts[1]) <= 31:
            return False
    if host.startswith("100."):
        parts = host.split(".")
        if len(parts) >= 2 and parts[1].isdigit() and 64 <= int(parts[1]) <= 127:
            return False
    return True


class TestEvidenceUrlSafety(unittest.TestCase):
    def test_accepts_real_evidence_sources(self):
        for url in [
            "https://docs.uniswap.org/contracts/v4/concepts/dynamic-fees",
            "https://raw.githubusercontent.com/Uniswap/v4-core/main/README.md",
            "http://gov.uniswap.org/",
        ]:
            self.assertTrue(is_safe_evidence_url(url), url)

    def test_rejects_non_http_schemes(self):
        for url in ["ftp://example.com", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,x"]:
            self.assertFalse(is_safe_evidence_url(url), url)

    def test_rejects_loopback_and_private_hosts(self):
        for url in [
            "http://localhost/",
            "http://127.0.0.1/",
            "http://127.0.0.1:8080/admin",
            "http://0.0.0.0/",
            "http://10.0.0.5/",
            "http://192.168.1.1/",
            "http://169.254.169.254/latest/meta-data/",  # cloud metadata endpoint
            "http://[::1]/",
            "https://metadata.google.internal/computeMetadata/v1/",
        ]:
            self.assertFalse(is_safe_evidence_url(url), url)

    def test_rejects_bare_numeric_hosts(self):
        # v0.3.6: "2130706433" is 127.0.0.1 as a decimal integer — some HTTP
        # clients resolve this. No legitimate evidence source is a bare number.
        for url in ["http://2130706433/", "http://017700000001/"]:
            self.assertFalse(is_safe_evidence_url(url), url)

    def test_rejects_cgnat_range_but_allows_outside_it(self):
        # v0.3.6: 100.64.0.0/10 (RFC 6598 CGNAT) — 100.64.x.x-100.127.x.x blocked,
        # 100.128.x.x and 100.63.x.x are outside the range and stay allowed.
        self.assertFalse(is_safe_evidence_url("http://100.64.0.1/"))
        self.assertFalse(is_safe_evidence_url("http://100.127.255.255/"))
        self.assertTrue(is_safe_evidence_url("http://100.128.0.1/"))
        self.assertTrue(is_safe_evidence_url("http://100.63.0.1/"))

    def test_rejects_private_172_range_but_allows_public_172(self):
        self.assertFalse(is_safe_evidence_url("http://172.16.0.1/"))
        self.assertFalse(is_safe_evidence_url("http://172.31.255.255/"))
        # 172.32.x.x and above are NOT in the private range (172.16-172.31 only).
        self.assertTrue(is_safe_evidence_url("http://172.32.0.1/"))

    def test_rejects_empty_and_malformed(self):
        for url in ["", "not-a-url", "http://"]:
            self.assertFalse(is_safe_evidence_url(url), url)


# ============================================================================
# Mirrors contract.py's _content_hash (SHA-256 provenance fingerprint)
# ============================================================================


def content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class TestContentHash(unittest.TestCase):
    def test_deterministic(self):
        self.assertEqual(content_hash("hello"), content_hash("hello"))

    def test_sensitive_to_content(self):
        self.assertNotEqual(content_hash("hello"), content_hash("Hello"))

    def test_is_real_sha256_not_truncated(self):
        # A prior version used a hand-rolled 64-bit FNV-1a fingerprint
        # (16 hex chars) — this asserts the fix: real SHA-256 is 64 hex
        # chars (256 bits).
        self.assertEqual(len(content_hash("anything")), 64)
        self.assertEqual(content_hash(""), hashlib.sha256(b"").hexdigest())


# ============================================================================
# Mirrors contract.py's partial-verdict payout split (inside _settle_claim)
# ============================================================================


def compute_partial_split(reward: int, payout_bps: int) -> tuple:
    """claimant_share, challenger_share_from_reward — mirrors:
        bps = max(0, min(10000, payout_bps))
        claimant_share = (reward * bps) // 10000
        challenger_share = reward - claimant_share
    """
    bps = max(0, min(10000, payout_bps))
    claimant_share = (reward * bps) // 10000
    challenger_share = reward - claimant_share
    return claimant_share, challenger_share


class TestPartialSplitConservation(unittest.TestCase):
    """The single most important escrow invariant: a partial split must
    never create or destroy GEN — claimant_share + challenger_share must
    always equal the original reward, for every possible bps value."""

    def test_conservation_across_full_bps_range(self):
        reward = 12345 * 10**18  # arbitrary non-round GEN amount, base units
        for bps in range(0, 10001, 137):  # sample the whole range, not just edges
            claimant_share, challenger_share = compute_partial_split(reward, bps)
            self.assertEqual(claimant_share + challenger_share, reward, f"bps={bps}")
            self.assertGreaterEqual(claimant_share, 0)
            self.assertGreaterEqual(challenger_share, 0)

    def test_bps_10000_gives_everything_to_claimant(self):
        reward = 500 * 10**18
        claimant_share, challenger_share = compute_partial_split(reward, 10000)
        self.assertEqual(claimant_share, reward)
        self.assertEqual(challenger_share, 0)

    def test_bps_0_gives_everything_to_challenger(self):
        reward = 500 * 10**18
        claimant_share, challenger_share = compute_partial_split(reward, 0)
        self.assertEqual(claimant_share, 0)
        self.assertEqual(challenger_share, reward)

    def test_bps_5000_splits_evenly_with_remainder_to_challenger(self):
        # 101 is odd, so an exact 50/50 split has a 1-unit remainder;
        # integer division means claimant rounds down, challenger absorbs
        # the remainder via `reward - claimant_share` — verifies no unit
        # is silently lost.
        claimant_share, challenger_share = compute_partial_split(101, 5000)
        self.assertEqual(claimant_share, 50)
        self.assertEqual(challenger_share, 51)
        self.assertEqual(claimant_share + challenger_share, 101)

    def test_out_of_range_bps_is_clamped_not_erroring(self):
        reward = 100 * 10**18
        self.assertEqual(compute_partial_split(reward, -50), compute_partial_split(reward, 0))
        self.assertEqual(compute_partial_split(reward, 15000), compute_partial_split(reward, 10000))


# ============================================================================
# Mirrors contract.py's _round_bps (validator payout_bps agreement tolerance)
# ============================================================================


def round_bps(value: int, step: int = 2000) -> int:
    return int(round(value / step) * step)


class TestBpsRounding(unittest.TestCase):
    # step=2000 (v0.3.4, widened from 500) — a +-1000bps agreement window,
    # up from +-250bps, after four consecutive live liveness failures
    # showed the tighter window was unreliable for two independent LLM
    # judgment syntheses on deliberately ambiguous claims.
    def test_rounds_to_nearest_step(self):
        self.assertEqual(round_bps(4900), 4000)
        self.assertEqual(round_bps(5100), 6000)
        self.assertEqual(round_bps(0), 0)
        self.assertEqual(round_bps(10000), 10000)

    def test_two_close_but_not_identical_values_can_still_agree(self):
        # This is the whole point of rounding before the equivalence check:
        # two independent validator LLM calls landing on 3200 vs 4800 (a
        # 1600bps spread, both within the 3000-5000 bucket that rounds to
        # 4000) should now be treated as agreement, not a disagreement —
        # the old 500-step tolerance would have rejected this.
        self.assertEqual(round_bps(3200), round_bps(4800))


# ============================================================================
# Mirrors contract.py's _extract_host / _is_verified_primary_source
# (v0.3.7, audit remaining-blocker #2 — source tiers were self-declared)
# ============================================================================


def extract_host(url: str) -> str:
    lowered = url.strip().lower()
    if "://" not in lowered:
        return ""
    rest = lowered.split("://", 1)[1]
    host_and_maybe_port = rest.split("/", 1)[0].split("@")[-1]
    if host_and_maybe_port.startswith("["):
        return ""
    return host_and_maybe_port.split(":", 1)[0]


def is_verified_primary_source(url: str, official_domains: list) -> bool:
    if not official_domains:
        return False
    host = extract_host(url)
    if not host:
        return False
    for domain in official_domains:
        domain = domain.strip().lower()
        if domain and (host == domain or host.endswith("." + domain)):
            return True
    return False


class TestVerifiedPrimarySource(unittest.TestCase):
    def test_matches_exact_domain(self):
        self.assertTrue(is_verified_primary_source("https://uniswap.org/whitepaper.pdf", ["uniswap.org"]))

    def test_matches_subdomain(self):
        self.assertTrue(is_verified_primary_source("https://docs.uniswap.org/contracts/v4", ["uniswap.org"]))
        self.assertTrue(is_verified_primary_source("https://gov.uniswap.org/t/123", ["uniswap.org"]))

    def test_rejects_unrelated_domain(self):
        self.assertFalse(is_verified_primary_source("https://some-random-blog.com/uniswap-is-great", ["uniswap.org"]))

    def test_rejects_lookalike_domain(self):
        # "uniswap.org.evil.com" ends with ".org.evil.com", not ".uniswap.org"
        # — must not match via naive substring search.
        self.assertFalse(is_verified_primary_source("https://uniswap.org.evil.com/", ["uniswap.org"]))
        # "notuniswap.org" is not "uniswap.org" and does not end with
        # ".uniswap.org" either — must not match via naive suffix search.
        self.assertFalse(is_verified_primary_source("https://notuniswap.org/", ["uniswap.org"]))

    def test_no_official_domains_registered_means_unverified(self):
        self.assertFalse(is_verified_primary_source("https://docs.uniswap.org/", []))

    def test_multiple_registered_domains(self):
        domains = ["uniswap.org", "app.uniswap.org.example-mirror.io"]
        self.assertTrue(is_verified_primary_source("https://blog.uniswap.org/", domains))


# ============================================================================
# Mirrors contract.py's _select_judged_evidence (per-party evidence slots —
# the audit-finding-#3 griefing fix, extended in v0.3.7 with verified-source
# tiering for audit remaining-blocker #2)
# ============================================================================


PRIMARY_EVIDENCE_TYPES = frozenset({
    "PROTOCOL_DOCUMENTATION", "GOVERNANCE_PROPOSAL", "BLOCKCHAIN_TRANSACTION", "OFFICIAL_ANNOUNCEMENT",
})


def _tier_rank(item: dict, official_domains) -> int:
    if item.get("evidence_type") not in PRIMARY_EVIDENCE_TYPES:
        return 2
    if official_domains and is_verified_primary_source(item.get("url") or "", official_domains):
        return 0
    return 1


def _primary_first(items: list, official_domains=None) -> list:
    return sorted(items, key=lambda e: _tier_rank(e, official_domains))


def select_judged_evidence(evidence_items: list, claimant: str, challenger: str, per_party: int = 4, official_domains=None) -> list:
    claimant_items = _primary_first([e for e in evidence_items if e.get("submitter") == claimant], official_domains)[:per_party]
    challenger_items = _primary_first([e for e in evidence_items if e.get("submitter") == challenger], official_domains)[:per_party]

    total_cap = per_party * 2
    remaining = total_cap - len(claimant_items) - len(challenger_items)
    third_party = []
    if remaining > 0:
        for e in evidence_items:
            submitter = e.get("submitter")
            if submitter != claimant and submitter != challenger:
                third_party.append(e)
                if len(third_party) >= remaining:
                    break
    return claimant_items + challenger_items + third_party


def _evidence(eid, submitter, evidence_type="URL", url=""):
    return {"id": eid, "submitter": submitter, "evidence_type": evidence_type, "url": url}


class TestEvidenceSlotGriefingFix(unittest.TestCase):
    def test_one_party_cannot_crowd_out_the_other(self):
        """The exact griefing scenario the audit flagged: claimant floods
        8 low-quality items immediately, challenger submits 1 strong item
        later. Under the old "first 8 overall" rule, the challenger's
        evidence would never be judged. Under per-party slots, it must be."""
        claimant = "0xClaimant"
        challenger = "0xChallenger"
        items = [_evidence(f"c{i}", claimant) for i in range(8)]  # flood
        items.append(_evidence("strong", challenger))  # submitted late

        judged = select_judged_evidence(items, claimant, challenger)
        judged_ids = {e["id"] for e in judged}

        self.assertIn("strong", judged_ids, "challenger's evidence must not be crowded out")
        # Claimant's flood is capped at their own 4 slots, not all 8.
        claimant_judged = [e for e in judged if e["submitter"] == claimant]
        self.assertLessEqual(len(claimant_judged), 4)

    def test_both_parties_get_up_to_four_slots_each(self):
        claimant, challenger = "0xA", "0xB"
        items = [_evidence(f"a{i}", claimant) for i in range(6)] + [_evidence(f"b{i}", challenger) for i in range(6)]
        judged = select_judged_evidence(items, claimant, challenger)
        claimant_judged = [e for e in judged if e["submitter"] == claimant]
        challenger_judged = [e for e in judged if e["submitter"] == challenger]
        self.assertEqual(len(claimant_judged), 4)
        self.assertEqual(len(challenger_judged), 4)
        self.assertEqual(len(judged), 8)

    def test_third_party_evidence_fills_leftover_slots(self):
        claimant, challenger = "0xA", "0xB"
        items = [_evidence("a0", claimant), _evidence("b0", challenger), _evidence("third", "0xThirdParty")]
        judged = select_judged_evidence(items, claimant, challenger)
        judged_ids = {e["id"] for e in judged}
        self.assertIn("third", judged_ids)

    def test_never_exceeds_total_cap(self):
        claimant, challenger = "0xA", "0xB"
        items = (
            [_evidence(f"a{i}", claimant) for i in range(10)]
            + [_evidence(f"b{i}", challenger) for i in range(10)]
            + [_evidence(f"t{i}", "0xThird") for i in range(10)]
        )
        judged = select_judged_evidence(items, claimant, challenger)
        self.assertLessEqual(len(judged), 8)

    def test_primary_sources_prioritized_within_a_partys_own_slots(self):
        """v0.3.6, audit remaining-blocker #4: if a party submits more than
        their 4-slot allowance, their PRIMARY-tier evidence (official docs,
        governance, on-chain data) must win the slots over their own
        CORROBORATIVE-tier evidence (forum posts, social posts) — even if
        the corroborative items were submitted first."""
        claimant, challenger = "0xA", "0xB"
        items = [
            _evidence("forum1", claimant, "FORUM_DISCUSSION"),
            _evidence("social1", claimant, "SOCIAL_POST"),
            _evidence("forum2", claimant, "FORUM_DISCUSSION"),
            _evidence("docs1", claimant, "PROTOCOL_DOCUMENTATION"),  # submitted last, still primary
            _evidence("gov1", claimant, "GOVERNANCE_PROPOSAL"),
            _evidence("b0", challenger, "URL"),
        ]
        judged = select_judged_evidence(items, claimant, challenger)
        claimant_judged_ids = {e["id"] for e in judged if e["submitter"] == claimant}
        self.assertIn("docs1", claimant_judged_ids)
        self.assertIn("gov1", claimant_judged_ids)
        self.assertEqual(len(claimant_judged_ids), 4)

    def test_verified_primary_outranks_unverified_primary_and_corroborative(self):
        """v0.3.7: within one party's own 4 slots, a VERIFIED primary source
        (URL host matches the protocol's registered official domain) must
        be selected ahead of a self-declared-but-unverified primary item
        and ahead of corroborative evidence, even when it was submitted
        last — a label alone should not outrank an actually-checked source."""
        claimant, challenger = "0xA", "0xB"
        official_domains = ["uniswap.org"]
        items = [
            _evidence("forum1", claimant, "FORUM_DISCUSSION", "https://reddit.com/r/uniswap"),
            _evidence("fake_primary", claimant, "PROTOCOL_DOCUMENTATION", "https://totally-not-uniswap.example.com/docs"),
            _evidence("social1", claimant, "SOCIAL_POST", "https://twitter.com/uniswap/status/1"),
            _evidence("real_primary", claimant, "PROTOCOL_DOCUMENTATION", "https://docs.uniswap.org/contracts/v4"),
            _evidence("b0", challenger, "URL", "https://example.com"),
        ]
        judged = select_judged_evidence(items, claimant, challenger, official_domains=official_domains)
        claimant_judged = [e["id"] for e in judged if e["submitter"] == claimant]
        # All 4 of the claimant's items fit within their cap here, but the
        # ORDER must put the verified source first.
        self.assertEqual(claimant_judged[0], "real_primary")
        self.assertEqual(claimant_judged[1], "fake_primary")


# ============================================================================
# Mirrors contract.py's _normalize_html_to_text / _extract_deterministic_excerpt
# (v0.3.5 deterministic-core redesign — the audit's remaining-blocker #1 fix,
# replacing the LLM-based extraction step that failed live validator
# consensus four consecutive times)
# ============================================================================

_TAG_RE = re.compile(r"<[^>]+>")
_WHITESPACE_RE = re.compile(r"\s+")
_WORD_RE = re.compile(r"[A-Za-z0-9]+")
_HTML_ENTITIES = {
    "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">",
    "&quot;": '"', "&#39;": "'", "&apos;": "'",
}
_STOPWORDS = frozenset({
    "this", "that", "with", "from", "have", "does", "will", "your",
    "their", "about", "into", "such", "than", "then", "when", "what",
    "which", "where", "while", "there", "these", "those", "over", "under",
    "protocol", "claims",
})
EXCERPT_WINDOW_CHARS = 600
MIN_KEYWORD_LEN = 4


def normalize_html_to_text(html: str) -> str:
    text = _TAG_RE.sub(" ", html)
    for entity, replacement in _HTML_ENTITIES.items():
        text = text.replace(entity, replacement)
    text = _WHITESPACE_RE.sub(" ", text).strip()
    return text.lower()


def extract_deterministic_excerpt(normalized_text: str, subject: str, source_statement: str) -> str:
    if not normalized_text:
        return ""
    keywords = [
        w for w in _WORD_RE.findall((subject + " " + source_statement).lower())
        if len(w) >= MIN_KEYWORD_LEN and w not in _STOPWORDS
    ]
    earliest_pos = None
    for kw in keywords:
        pos = normalized_text.find(kw)
        if pos != -1 and (earliest_pos is None or pos < earliest_pos):
            earliest_pos = pos
    start = 0 if earliest_pos is None else max(0, earliest_pos - 100)
    return normalized_text[start:start + EXCERPT_WINDOW_CHARS]


class TestNormalizeHtmlToText(unittest.TestCase):
    def test_strips_tags(self):
        self.assertEqual(normalize_html_to_text("<p>Hello <b>world</b></p>"), "hello world")

    def test_decodes_common_entities(self):
        self.assertEqual(normalize_html_to_text("Fees &amp; Governance &nbsp;caps"), "fees & governance caps")

    def test_collapses_whitespace(self):
        self.assertEqual(normalize_html_to_text("a\n\n\t  b   c"), "a b c")

    def test_lowercases(self):
        self.assertEqual(normalize_html_to_text("UniSwap V4"), "uniswap v4")

    def test_deterministic_across_repeated_calls(self):
        html = "<div>Hook fees <span>bypass</span> the governance &amp; cap.</div>"
        self.assertEqual(normalize_html_to_text(html), normalize_html_to_text(html))

    def test_empty_input(self):
        self.assertEqual(normalize_html_to_text(""), "")


class TestExtractDeterministicExcerpt(unittest.TestCase):
    def test_deterministic_across_repeated_calls(self):
        """The core property this replaces LLM extraction to guarantee:
        given identical input, the output must be byte-identical every
        single time — this is what makes strict_eq (instead of
        prompt_comparative) valid for this step."""
        text = "the quick brown fox jumps over the lazy dog near the riverbank " * 20
        subject = "fox jumping behavior"
        statement = "foxes are known to jump over lazy dogs"
        first = extract_deterministic_excerpt(text, subject, statement)
        for _ in range(10):
            self.assertEqual(extract_deterministic_excerpt(text, subject, statement), first)

    def test_anchors_on_earliest_keyword_match(self):
        text = "irrelevant filler text here. " * 5 + "hook fees bypass governance entirely. " + "more filler. " * 5
        excerpt = extract_deterministic_excerpt(text, "hook fees", "governance bypass claim")
        self.assertIn("hook fees bypass governance", excerpt)

    def test_falls_back_to_start_when_no_keyword_matches(self):
        text = "some totally unrelated content about a completely different subject matter entirely"
        excerpt = extract_deterministic_excerpt(text, "zzzznonexistentword", "anotherzzzznonexistentterm")
        self.assertTrue(text.startswith(excerpt[:20]))

    def test_empty_input_returns_empty(self):
        self.assertEqual(extract_deterministic_excerpt("", "subject", "statement"), "")

    def test_excerpt_is_bounded(self):
        text = "word " * 5000
        excerpt = extract_deterministic_excerpt(text, "word", "word")
        self.assertLessEqual(len(excerpt), EXCERPT_WINDOW_CHARS)

    def test_short_stopwords_and_common_terms_are_not_used_as_anchors(self):
        # "protocol" and "claims" are in the stopword list (too generic to
        # be a useful anchor in THIS contract's domain) — a text containing
        # only those plus real filler should fall back to the start, not
        # anchor on a near-universal word.
        text = "unrelated opening sentence. " * 3 + "protocol claims this and that. " + "more filler " * 20
        excerpt = extract_deterministic_excerpt(text, "protocol claims", "this and that")
        self.assertTrue(text.startswith(excerpt[:20]))


if __name__ == "__main__":
    unittest.main()
