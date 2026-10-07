-- AlterTable
ALTER TABLE "smtp_accounts" ADD COLUMN     "deliverability" JSONB,
ADD COLUMN     "deliverabilityAt" TIMESTAMP(3),
ADD COLUMN     "dkimEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "dkimPrivateKeyEnc" TEXT,
ADD COLUMN     "dkimPublicKey" TEXT,
ADD COLUMN     "dkimSelector" TEXT;

