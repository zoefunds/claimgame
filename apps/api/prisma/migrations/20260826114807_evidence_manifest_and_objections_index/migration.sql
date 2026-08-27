-- AlterTable
ALTER TABLE "evidence" ADD COLUMN     "content_hash" TEXT,
ADD COLUMN     "retrieved_at" TIMESTAMP(3);
