-- AlterTable
ALTER TABLE "evidence" ADD COLUMN     "archived_content" TEXT,
ADD COLUMN     "archived_at" TIMESTAMP(3),
ADD COLUMN     "archive_hash_matches" BOOLEAN;
