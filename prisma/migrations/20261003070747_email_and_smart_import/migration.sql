-- CreateEnum
CREATE TYPE "EmailStatus2" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'SKIPPED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'QUEUED', 'SENDING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED');

-- AlterTable
ALTER TABLE "imports" ADD COLUMN     "delimiter" TEXT,
ADD COLUMN     "detection" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "draftStep" TEXT NOT NULL DEFAULT 'mapping',
ADD COLUMN     "encoding" TEXT,
ADD COLUMN     "headerRow" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "sheetName" TEXT,
ADD COLUMN     "sheets" JSONB NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "smtp_accounts" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "label" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "secure" BOOLEAN NOT NULL DEFAULT true,
    "username" TEXT NOT NULL,
    "passwordEnc" TEXT NOT NULL,
    "fromName" TEXT NOT NULL,
    "fromEmail" TEXT NOT NULL,
    "replyTo" TEXT,
    "dailyLimit" INTEGER NOT NULL DEFAULT 500,
    "perMinuteLimit" INTEGER NOT NULL DEFAULT 30,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "lastVerifiedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "smtp_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_templates" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "subject" TEXT NOT NULL,
    "preheader" TEXT,
    "design" JSONB NOT NULL,
    "html" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "email_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_campaigns" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "name" TEXT NOT NULL,
    "smtpAccountId" TEXT NOT NULL,
    "templateId" TEXT,
    "subject" TEXT NOT NULL,
    "preheader" TEXT,
    "design" JSONB NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'QUEUED',
    "audience" JSONB NOT NULL,
    "trackOpens" BOOLEAN NOT NULL DEFAULT true,
    "scheduledFor" TIMESTAMP(3),
    "totalRecipients" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "openedCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "email_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_messages" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "campaignId" TEXT,
    "smtpAccountId" TEXT NOT NULL,
    "leadId" TEXT,
    "clientLeadId" TEXT,
    "toEmail" TEXT NOT NULL,
    "toName" TEXT,
    "subject" TEXT NOT NULL,
    "status" "EmailStatus2" NOT NULL DEFAULT 'QUEUED',
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "providerMessageId" TEXT,
    "trackingToken" TEXT NOT NULL,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3),
    "openCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_suppressions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "emailHash" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_suppressions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "smtp_accounts_organizationId_idx" ON "smtp_accounts"("organizationId");

-- CreateIndex
CREATE INDEX "email_templates_organizationId_archivedAt_idx" ON "email_templates"("organizationId", "archivedAt");

-- CreateIndex
CREATE INDEX "email_campaigns_organizationId_createdAt_idx" ON "email_campaigns"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "email_messages_trackingToken_key" ON "email_messages"("trackingToken");

-- CreateIndex
CREATE INDEX "email_messages_campaignId_status_idx" ON "email_messages"("campaignId", "status");

-- CreateIndex
CREATE INDEX "email_messages_organizationId_createdAt_idx" ON "email_messages"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "email_messages_clientLeadId_idx" ON "email_messages"("clientLeadId");

-- CreateIndex
CREATE INDEX "email_messages_smtpAccountId_sentAt_idx" ON "email_messages"("smtpAccountId", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "email_suppressions_organizationId_emailHash_key" ON "email_suppressions"("organizationId", "emailHash");

-- AddForeignKey
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "email_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Platform rows have NULL organizationId: enforce uniqueness for them separately.
CREATE UNIQUE INDEX email_suppressions_platform_hash ON email_suppressions ("emailHash") WHERE "organizationId" IS NULL;
-- At most one default sender per scope.
CREATE UNIQUE INDEX smtp_accounts_one_default_org ON smtp_accounts ("organizationId") WHERE "isDefault" AND "deletedAt" IS NULL AND "organizationId" IS NOT NULL;
CREATE UNIQUE INDEX smtp_accounts_one_default_platform ON smtp_accounts ((1)) WHERE "isDefault" AND "deletedAt" IS NULL AND "organizationId" IS NULL;

-- Tenant isolation for email data (same policy as other tenant tables; NULL org rows are platform-only).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['smtp_accounts', 'email_templates', 'email_campaigns', 'email_messages', 'email_suppressions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (app_bypass() OR "organizationId" = app_org())
      WITH CHECK (app_bypass() OR "organizationId" = app_org())$p$, t);
  END LOOP;
END $$;
