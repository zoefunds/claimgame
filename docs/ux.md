# CLAIMGAME — UX/UI Architecture (Phase 3)

Visual language extracted from your prototypes (`active-investigation.html`, `hunt-board.html`, `landingpage.html`, `leaderboard.html`, `DESIGN.md`) — read as reference, not copied verbatim, and extended to cover every screen ClaimGame.md requires that wasn't prototyped.

## Design tokens (source of truth → `packages/ui`)

Carried forward as-is from `DESIGN.md`: the "Protocol Investigative Interface" system — deep-navy surface stack (`#0b1326` → `#2d3449`), cyan primary (`#00dbe9`/`#dbfcff`), indigo secondary (`#c0c1ff`), amber tertiary (`#fed639`) for warnings/pending states, 4px-radius "severe and functional" shapes, Inter for UI text, JetBrains Mono for anything cryptographic/numeric (addresses, GEN amounts, tx hashes, timestamps). Zero drop shadows — depth via tonal layering only. This is CLAIMGAME's distinctive identity (a "Detective Dashboard," not a generic Web3 neon-glow template), reused across every screen below rather than reinvented per page.

## Navigation

Persistent left sidebar (desktop) / top bar + bottom-safe mobile nav: **Home · Hunt Board · My Cases · Create Claim · Leaderboard · Seasons · Profile · Notifications · Settings · How It Works**. Wallet connect state and GEN balance live in the sidebar header, matching the prototypes.

## Pages

1. **Landing** (`/`) — hero ("Put money behind your interpretation of a protocol"), Operational Loop (Discover→Investigate→Interpret→Stake→Defend→Judgment), Declared-vs-Observed-Reality comparison section, Active Boss Claim preview, CTA, FAQ, footer. Public, no wallet required.
2. **Hunt Board** (`/claims`) — the claim discovery grid/list (prototyped in `active-investigation.html`), filters (protocol, category, difficulty, reward size, status), search, grid/list toggle, pagination.
3. **Claim Detail** (`/claims/[id]`) — investigative case-file layout (prototyped in `hunt-board.html`): header (protocol/subject/status/difficulty/bond), Core Discrepancy (source statement vs canonical interpretation), Version History, Declared vs Observed Reality, Evidence Board, Objections feed, Challenge/Defense action panel, GenLayer judgment status, transaction history. Server Component shell, Client Components for the stake/sign panel.
4. **Create Claim** (`/claims/new`) — guided 8-step wizard: protocol → source statement → interpretation → evidence → bond → optional bounty → review → submit + wallet confirmation. One step per screen on mobile, stepper sidebar on desktop.
5. **Challenge flow** (`/claims/[id]/challenge`) — investigate → contradiction finder → argument + evidence → stake amount → review → sign → status tracker.
6. **Defense/amendment flow** (`/claims/[id]/amend`) — respond to objection or submit an amended interpretation; shows the version diff against the current canonical version.
7. **Resolution screen** (`/claims/[id]/resolution`) — "Case Submitted → Evidence collected → GenLayer analysis → Validator evaluation → Consensus → Verdict" progress, then verdict + confidence + evidence considered + reasoning summary + economic outcome + reputation impact, in plain language ("not infallible" framing per ClaimGame.md).
8. **Leaderboard** (`/leaderboard`) — season header + countdown, player profile bento, three ranked tables (Top Interpreters / Top Detectives / Top Evidence Hunters), prototyped in `leaderboard.html`.
9. **Seasons** (`/seasons`, `/seasons/[id]`) — season list + per-season category winners.
10. **Profile** (`/profile/[address]`) — reputation dimensions (Interpretation Accuracy / Challenge Accuracy / Evidence Reliability), archetype badges, claim/challenge history, progression tier (Novice→Analyst→Investigator→Interpreter→Specialist→Oracle).
11. **My Cases** (`/my-cases`) — the connected wallet's own claims/challenges across all statuses, tabbed.
12. **Notifications** (`/notifications`) — challenge received, objection raised, judgment ready, bounty paid, etc.
13. **Settings** (`/settings`) — display name, connected-wallet management, notification preferences.
14. **How It Works** (`/how-it-works`) — the operational loop explained in depth, FAQ.

## Cross-cutting states

- **Transaction lifecycle** (every write): Idle → Preparing → Wallet Prompt → Submitted → Pending → Confirmed/Finalized → Success, and Rejected/Failed/Timed Out/Unknown as terminal alternates — never shows "Success" from a bare tx hash; polls actual GenLayer transaction status.
- **Loading**: skeleton cards matching the Hunt Board/claim-detail grid shapes, not spinners, to avoid layout shift.
- **Empty**: "No active investigations match these filters" with a CTA to clear filters or create a claim.
- **Error**: inline, non-blocking for read failures (stale-data banner + retry); modal/blocking only for a failed write the user must acknowledge.
- **Mobile**: single-column stacks, bottom sheet for the stake/sign action panel instead of a sticky sidebar, top nav collapses to a menu icon (prototyped in `active-investigation.html`'s mobile header).

## Component inventory (→ `packages/ui`)

Case Card, Evidence Card (URL / tx / screenshot variants), Difficulty Badge, Status Badge, GEN Amount (mono, icon-paired), Stake Input, Transaction Status Toast, Verdict Panel, Version Timeline, Objection Thread Item, Leaderboard Row, Reputation Stat Block, Progress Bar (geometric, non-rounded per DESIGN.md), Season Countdown, Wallet Connect Button, Protocol/Difficulty/Reward filter dropdowns.
