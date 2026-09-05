#!/usr/bin/env bash
# Single entrypoint for every locally reproducible check this project has.
# Mirrors .github/workflows/*.yml exactly (same commands, same order) so a
# green run here means CI would also be green — run this instead of copying
# individual commands out of the README by hand.
#
# Usage: ./scripts/run-all-checks.sh
# (or:   pnpm run verify)
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== 1/6 Python — contract pure-logic + adversarial tests =="
python3 -m unittest discover -s tests -v

echo "== 2/6 Node — vote-decoding mirror tests =="
node tests/test_vote_decoding.mjs

echo "== 3/6 Node — CIDv1 implementation tests =="
node tests/test_cid.mjs

echo "== 4/6 Contract syntax + GenVM lint =="
python3 -m py_compile contracts/claimgame/contract.py
genvm-lint check contracts/claimgame/contract.py --json

echo "== 5/6 Install deps + generate Prisma client =="
pnpm install --frozen-lockfile
pnpm --filter @claimgame/api exec prisma generate

echo "== 6/6 Typecheck + build (web, api) =="
pnpm --filter @claimgame/web typecheck
pnpm --filter @claimgame/api typecheck
pnpm --filter @claimgame/api build
pnpm --filter @claimgame/web build

echo ""
echo "All checks passed. This does NOT include the live on-chain smoke tests"
echo "(node scripts/product-test-*.mjs) — those need a funded StudioNet"
echo "account and a reachable deployed contract, see README's Live"
echo "verification section."
