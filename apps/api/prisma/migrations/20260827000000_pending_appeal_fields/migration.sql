-- AlterTable
ALTER TABLE "claims" ADD COLUMN     "pending_verdict" TEXT,
ADD COLUMN     "pending_payout_bps" INTEGER,
ADD COLUMN     "appeal_deadline" TIMESTAMP(3);
