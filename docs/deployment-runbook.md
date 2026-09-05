# CLAIMGAME — Deployment Runbook

This is the exact, tested procedure used throughout this project's development to redeploy any part of the stack — not aspirational, every step here has actually been run. Follow it top-to-bottom whenever the contract address changes; individual sections stand alone for other redeploys.

## Contract redeploy checklist

Copy this into the PR/commit description for any redeploy and check off each line — every item links to the section below that actually performs it:

- [ ] **Deploy address recorded** — new address from `genlayer deploy` (§1) written down before anything else happens
- [ ] **Contract/source match verified** — `genvm-lint check contracts/claimgame/contract.py --json` shows `"ok": true` against the EXACT file that was deployed (no uncommitted local diff between what was deployed and what's in git — check with `git status contracts/claimgame/contract.py`)
- [ ] **All 4 env locations updated** (§2) — `.env.example` files, Fly secrets (api + indexer), Vercel production env
- [ ] **Pending Prisma migrations applied**, if any (§3)
- [ ] **CACHE tables cleared AFTER confirming no old-config indexer machine can poll again** — a rolling deploy briefly leaves the OLD indexer process running on the OLD contract address; if it fires a scheduled poll in that window (which resyncs its *entire* history, since the cursor was just cleared), it will silently re-insert stale data. Truncate, `fly deploy`, then re-check `fly machines list --app claimgame-indexer` for all machines on the new image, and re-truncate if any machine's `LAST UPDATED` predates the truncate — confirmed via `fly logs` in a real 2026-09-05 redeploy (v0.3.11, see docs/genlayer.md)
- [ ] **API + indexer redeployed**, frontend redeployed (§4, §5)
- [ ] **`/healthz` confirms the new address** (§6)
- [ ] **Live smoke tests run against the new address** — at minimum `scripts/product-test-1-full-lifecycle.mjs`; run all 4 `scripts/product-test-*.mjs` for a full redeploy, not just a config change
- [ ] **Evidence links captured** — the new contract address, the healthz output, and each smoke test's printed transaction hashes recorded in the redeploy's commit message or PR description (not just "it worked" — the actual hashes, so anyone can independently re-check them against the explorer or `claim-game.vercel.app` afterward)
- [ ] **Docs updated** — any doc that names the previous contract address or version (`README.md`, `docs/genlayer.md`, `docs/threat-model.md`) updated to the new one, since a stale address in docs is worse than no address at all

## 1. Redeploying the contract (owner-only, never automated)

```bash
genlayer init                                              # regenerates the "Depends" pin — copy into contract.py's header
genvm-lint check contracts/claimgame/contract.py --json    # must show "ok": true before proceeding
genlayer network studionet
genlayer deploy --contract contracts/claimgame/contract.py
```

Record the new deployed address. Everything below assumes you have it.

## 2. Wire the new address into every environment location

Four locations must be updated in lockstep — missing one leaves part of the stack pointed at the old contract:

```bash
# Local env files (for future local dev / reference)
# .env.example, apps/web/.env.example, apps/api/.env.example, apps/web/.env.local
# — set CLAIMGAME_CONTRACT_ADDRESS / NEXT_PUBLIC_CLAIMGAME_CONTRACT_ADDRESS to the new address in each

# Fly secrets (both API and indexer read the same var name)
fly secrets set CLAIMGAME_CONTRACT_ADDRESS=0x... --app claimgame-api --stage
fly secrets set CLAIMGAME_CONTRACT_ADDRESS=0x... --app claimgame-indexer --stage

# Vercel (frontend)
cd apps/web
vercel env rm NEXT_PUBLIC_CLAIMGAME_CONTRACT_ADDRESS production --yes
echo "0x..." | vercel env add NEXT_PUBLIC_CLAIMGAME_CONTRACT_ADDRESS production
```

## 3. Apply any pending Prisma migrations

If the contract change also changed on-chain data shapes (new fields, new methods with new return shapes), there's usually a matching Prisma migration already written in `apps/api/prisma/migrations/`. Apply it directly against the production DB (this project uses `fly postgres connect` for raw SQL rather than a proxy tunnel, since the tunnel approach was unreliable in practice):

```bash
# Write the migration.sql content to a temp file, then:
fly postgres connect --app claimgame-db -d claimgame_api < /path/to/migration.sql
```

Then mark it as applied in Prisma's own migration history (requires the migration file to already be present in the deployed image — see step 4 first if this is a fresh migration):

```bash
fly ssh console --app claimgame-api -C "npx prisma migrate resolve --applied <migration_folder_name>"
```

## 4. Clear CACHE tables and redeploy API + indexer

CACHE tables mirror on-chain state from the OLD contract and must be cleared before the indexer starts syncing the new one (NATIVE tables — users, sessions, protocols, seasons — are never touched):

```bash
cat > /tmp/clear_cache.sql << 'EOF'
TRUNCATE TABLE leaderboard_entries, reputation_scores, reputation_events, resolutions, appeals, objections, challenges, evidence, claim_versions, claims, indexer_cursor CASCADE;
\q
EOF
fly postgres connect --app claimgame-db -d claimgame_api < /tmp/clear_cache.sql

fly deploy --app claimgame-api --config deploy/fly.api.toml --dockerfile deploy/Dockerfile.api
fly deploy --app claimgame-indexer --config deploy/fly.indexer.toml --dockerfile deploy/Dockerfile.indexer
```

If a migration needed resolving (step 3) and the migration file wasn't in the image yet, run the full app redeploy FIRST (so the file ships in the image), then run `prisma migrate resolve`, in that order.

## 5. Redeploy the frontend

```bash
cd apps/web
vercel deploy --prod --scope adebiyi2002gmailcoms-projects
```

## 6. Verify

```bash
curl -s https://claimgame-api.fly.dev/healthz
# Expect: {"status":"ok","contractAddress":"0x<the new address>",...}
```

Then run the live test scripts in `scripts/` against the new address before treating the deploy as verified — never assume a deploy succeeded just because the commands exited 0. See `docs/genlayer.md` for the full history of real bugs caught this way (transient StudioNet network errors, evidence-URL link rot, actual consensus disagreements) that a "deploy succeeded" status alone would have missed.

## Operational notes learned the hard way

- **Fly's build backend is occasionally flaky** ("no route to host", "context deadline exceeded" during `fly deploy`) — these are transient infra issues on Fly's side, not project bugs. Retry the exact same command; it has always succeeded on retry in this project's history.
- **`fly ssh console -C "..."` can also transiently fail** ("Server has closed the connection") — same treatment, retry.
- **StudioNet's RPC has two independent rate limits**: 500 requests/hour and 30 requests/minute. The indexer respects both (5-minute poll interval, tightened from 15 on 2026-09-05 — see `POLL_INTERVAL_MS` in `apps/api/src/indexer/index.ts` — + per-call throttling; `ACTIVE_CLAIM_CAPACITY_WARNING` was lowered to match). Live test scripts must throttle calls too (~2.4s spacing) or they'll get retry-exhausted errors mid-run.
- **`fly proxy` + a local `DATABASE_URL` for migrations was unreliable in practice** — `fly postgres connect` (piping raw SQL via stdin) proved more reliable for one-off schema changes.
