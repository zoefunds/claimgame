-- CreateTable
CREATE TABLE "users" (
    "wallet_address" TEXT NOT NULL,
    "display_name" TEXT,
    "avatar_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("wallet_address")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "wallet_address" TEXT NOT NULL,
    "refresh_token" TEXT NOT NULL,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_nonces" (
    "nonce" TEXT NOT NULL,
    "wallet_address" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),

    CONSTRAINT "auth_nonces_pkey" PRIMARY KEY ("nonce")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "wallet_address" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "protocols" (
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "protocols_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "seasons" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "seasons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "indexer_cursor" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "last_block" BIGINT NOT NULL DEFAULT 0,
    "last_event_id" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "indexer_cursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claims" (
    "id" TEXT NOT NULL,
    "protocol" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "source_statement" TEXT NOT NULL,
    "creator" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "difficulty" TEXT NOT NULL,
    "claim_bond_wei" TEXT NOT NULL,
    "claim_bond_deposited" TEXT NOT NULL,
    "current_version" INTEGER NOT NULL,
    "challenge_window_seconds" INTEGER NOT NULL,
    "season_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,
    "resolved_at" TIMESTAMP(3),
    "contract_tx_hash" TEXT NOT NULL,
    "synced_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claim_versions" (
    "claim_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "interpretation" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "rationale" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "claim_versions_pkey" PRIMARY KEY ("claim_id","version")
);

-- CreateTable
CREATE TABLE "evidence" (
    "id" TEXT NOT NULL,
    "claim_id" TEXT NOT NULL,
    "submitter" TEXT NOT NULL,
    "evidence_type" TEXT NOT NULL,
    "url" TEXT,
    "description" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "cited_in_verdict" BOOLEAN NOT NULL DEFAULT false,
    "submitted_at" TIMESTAMP(3) NOT NULL,
    "contract_tx_hash" TEXT NOT NULL,

    CONSTRAINT "evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "challenges" (
    "claim_id" TEXT NOT NULL,
    "challenger" TEXT NOT NULL,
    "challenge_stake_wei" TEXT NOT NULL,
    "challenge_stake_deposited" TEXT NOT NULL,
    "argument" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "contract_tx_hash" TEXT NOT NULL,

    CONSTRAINT "challenges_pkey" PRIMARY KEY ("claim_id")
);

-- CreateTable
CREATE TABLE "objections" (
    "id" TEXT NOT NULL,
    "claim_id" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "response" TEXT,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "objections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resolutions" (
    "claim_id" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "payout_bps" INTEGER NOT NULL,
    "reasoning_summary" TEXT NOT NULL,
    "evidence_cited" JSONB NOT NULL,
    "resolved_at" TIMESTAMP(3) NOT NULL,
    "contract_tx_hash" TEXT NOT NULL,

    CONSTRAINT "resolutions_pkey" PRIMARY KEY ("claim_id")
);

-- CreateTable
CREATE TABLE "reputation_events" (
    "id" TEXT NOT NULL,
    "user" TEXT NOT NULL,
    "claim_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "stake_weight" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reputation_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reputation_scores" (
    "wallet_address" TEXT NOT NULL,
    "interpretation_accuracy" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "challenge_accuracy" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "evidence_reliability" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "claims_created" INTEGER NOT NULL DEFAULT 0,
    "challenges_raised" INTEGER NOT NULL DEFAULT 0,
    "evidence_submitted" INTEGER NOT NULL DEFAULT 0,
    "progression_tier" TEXT NOT NULL DEFAULT 'NOVICE',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reputation_scores_pkey" PRIMARY KEY ("wallet_address")
);

-- CreateTable
CREATE TABLE "leaderboard_entries" (
    "season_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "wallet_address" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "score_value" DOUBLE PRECISION NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leaderboard_entries_pkey" PRIMARY KEY ("season_id","category","wallet_address")
);

-- CreateIndex
CREATE UNIQUE INDEX "sessions_refresh_token_key" ON "sessions"("refresh_token");

-- CreateIndex
CREATE INDEX "sessions_wallet_address_idx" ON "sessions"("wallet_address");

-- CreateIndex
CREATE INDEX "auth_nonces_wallet_address_idx" ON "auth_nonces"("wallet_address");

-- CreateIndex
CREATE INDEX "notifications_wallet_address_read_at_idx" ON "notifications"("wallet_address", "read_at");

-- CreateIndex
CREATE INDEX "claims_status_idx" ON "claims"("status");

-- CreateIndex
CREATE INDEX "claims_protocol_idx" ON "claims"("protocol");

-- CreateIndex
CREATE INDEX "claims_difficulty_idx" ON "claims"("difficulty");

-- CreateIndex
CREATE INDEX "evidence_claim_id_idx" ON "evidence"("claim_id");

-- CreateIndex
CREATE INDEX "challenges_challenger_idx" ON "challenges"("challenger");

-- CreateIndex
CREATE INDEX "objections_claim_id_idx" ON "objections"("claim_id");

-- CreateIndex
CREATE INDEX "reputation_events_user_idx" ON "reputation_events"("user");

-- CreateIndex
CREATE INDEX "reputation_events_claim_id_idx" ON "reputation_events"("claim_id");

-- CreateIndex
CREATE INDEX "leaderboard_entries_season_id_category_rank_idx" ON "leaderboard_entries"("season_id", "category", "rank");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_wallet_address_fkey" FOREIGN KEY ("wallet_address") REFERENCES "users"("wallet_address") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_wallet_address_fkey" FOREIGN KEY ("wallet_address") REFERENCES "users"("wallet_address") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_versions" ADD CONSTRAINT "claim_versions_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "objections" ADD CONSTRAINT "objections_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resolutions" ADD CONSTRAINT "resolutions_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;
