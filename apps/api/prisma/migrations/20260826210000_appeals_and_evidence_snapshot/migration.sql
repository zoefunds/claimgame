-- AlterTable
ALTER TABLE "evidence" ADD COLUMN     "snapshot_text" TEXT;

-- CreateTable
CREATE TABLE "appeals" (
    "claim_id" TEXT NOT NULL,
    "appellant" TEXT NOT NULL,
    "appeal_bond_wei" TEXT NOT NULL,
    "original_verdict" TEXT NOT NULL,
    "original_payout_bps" INTEGER NOT NULL,
    "appeal_verdict" TEXT NOT NULL,
    "appeal_payout_bps" INTEGER NOT NULL,
    "outcome" TEXT NOT NULL,
    "resolved_at" TIMESTAMP(3) NOT NULL,
    "contract_tx_hash" TEXT NOT NULL,

    CONSTRAINT "appeals_pkey" PRIMARY KEY ("claim_id")
);

-- AddForeignKey
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;
