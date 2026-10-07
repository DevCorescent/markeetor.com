-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('OPEN', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "saved_searches" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "filter" JSONB NOT NULL,
    "alertInApp" BOOLEAN NOT NULL DEFAULT true,
    "alertEmail" BOOLEAN NOT NULL DEFAULT false,
    "autoBuy" BOOLEAN NOT NULL DEFAULT false,
    "autoBuyMaxPerWeek" INTEGER NOT NULL DEFAULT 10,
    "autoBuyMaxPrice" DECIMAL(12,2),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "cursorAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastCheckedAt" TIMESTAMP(3),
    "lastMatchCount" INTEGER NOT NULL DEFAULT 0,
    "lastAlertAt" TIMESTAMP(3),
    "lastAutoBuyAt" TIMESTAMP(3),
    "totalAutoBought" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saved_searches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_watches" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_watches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_disputes" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientLeadId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "leadRequestId" TEXT,
    "reportedById" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "details" TEXT,
    "status" "DisputeStatus" NOT NULL DEFAULT 'OPEN',
    "paidAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "paidCredits" INTEGER NOT NULL DEFAULT 0,
    "refundCredits" INTEGER NOT NULL DEFAULT 0,
    "resolution" TEXT,
    "autoDecided" BOOLEAN NOT NULL DEFAULT false,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_disputes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "responseCode" INTEGER,
    "error" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_codes" (
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_codes_pkey" PRIMARY KEY ("organizationId")
);

-- CreateTable
CREATE TABLE "referrals" (
    "id" TEXT NOT NULL,
    "referrerOrgId" TEXT NOT NULL,
    "refereeOrgId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "rewardedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "saved_searches_organizationId_idx" ON "saved_searches"("organizationId");

-- CreateIndex
CREATE INDEX "saved_searches_active_idx" ON "saved_searches"("active");

-- CreateIndex
CREATE INDEX "market_watches_organizationId_userId_idx" ON "market_watches"("organizationId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "market_watches_userId_leadId_key" ON "market_watches"("userId", "leadId");

-- CreateIndex
CREATE UNIQUE INDEX "lead_disputes_code_key" ON "lead_disputes"("code");

-- CreateIndex
CREATE INDEX "lead_disputes_organizationId_createdAt_idx" ON "lead_disputes"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "lead_disputes_status_createdAt_idx" ON "lead_disputes"("status", "createdAt");

-- CreateIndex
CREATE INDEX "lead_disputes_leadId_idx" ON "lead_disputes"("leadId");

-- CreateIndex
CREATE UNIQUE INDEX "lead_disputes_clientLeadId_key" ON "lead_disputes"("clientLeadId");

-- CreateIndex
CREATE INDEX "webhook_deliveries_organizationId_createdAt_idx" ON "webhook_deliveries"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "webhook_deliveries_status_createdAt_idx" ON "webhook_deliveries"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "referral_codes_code_key" ON "referral_codes"("code");

-- CreateIndex
CREATE UNIQUE INDEX "referrals_refereeOrgId_key" ON "referrals"("refereeOrgId");

-- CreateIndex
CREATE INDEX "referrals_referrerOrgId_idx" ON "referrals"("referrerOrgId");

ALTER TABLE saved_searches ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_searches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON saved_searches
  USING (app_bypass() OR "organizationId" = app_org())
  WITH CHECK (app_bypass() OR "organizationId" = app_org());

ALTER TABLE market_watches ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_watches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON market_watches
  USING (app_bypass() OR "organizationId" = app_org())
  WITH CHECK (app_bypass() OR "organizationId" = app_org());

ALTER TABLE lead_disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_disputes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON lead_disputes
  USING (app_bypass() OR "organizationId" = app_org())
  WITH CHECK (app_bypass() OR "organizationId" = app_org());

ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON webhook_deliveries
  USING (app_bypass() OR "organizationId" = app_org())
  WITH CHECK (app_bypass() OR "organizationId" = app_org());

ALTER TABLE referral_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE referral_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON referral_codes
  USING (app_bypass() OR "organizationId" = app_org())
  WITH CHECK (app_bypass() OR "organizationId" = app_org());

-- Referrals span two workspaces: platform access only.
ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE referrals FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON referrals USING (app_bypass()) WITH CHECK (app_bypass());
