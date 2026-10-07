-- CreateTable
CREATE TABLE "funnels" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "baseFilter" JSONB NOT NULL DEFAULT '{"conditions":[]}',
    "stages" JSONB NOT NULL,
    "goal" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "funnels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "funnel_campaigns" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "funnelId" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "stageName" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "automated" BOOLEAN NOT NULL DEFAULT false,
    "emailCampaignId" TEXT,
    "recipients" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "details" JSONB,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "funnel_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "funnel_enrollments" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "funnelId" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "clientLeadId" TEXT NOT NULL,
    "enteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "result" TEXT,

    CONSTRAINT "funnel_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onboarding_forms" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "config" JSONB NOT NULL,
    "assets" JSONB NOT NULL DEFAULT '{}',
    "views" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "onboarding_forms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onboarding_applications" (
    "id" TEXT NOT NULL,
    "formId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "businessName" TEXT NOT NULL,
    "contactName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "website" TEXT,
    "industry" TEXT,
    "country" TEXT,
    "answers" JSONB NOT NULL,
    "leadInterests" JSONB,
    "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "quality" INTEGER NOT NULL DEFAULT 0,
    "ip" TEXT,
    "userAgent" TEXT,
    "organizationId" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "reason" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "onboarding_applications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "funnels_organizationId_status_idx" ON "funnels"("organizationId", "status");

-- CreateIndex
CREATE INDEX "funnel_campaigns_organizationId_funnelId_createdAt_idx" ON "funnel_campaigns"("organizationId", "funnelId", "createdAt");

-- CreateIndex
CREATE INDEX "funnel_enrollments_organizationId_idx" ON "funnel_enrollments"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "funnel_enrollments_funnelId_stageId_clientLeadId_key" ON "funnel_enrollments"("funnelId", "stageId", "clientLeadId");

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_forms_slug_key" ON "onboarding_forms"("slug");

-- CreateIndex
CREATE INDEX "onboarding_applications_formId_createdAt_idx" ON "onboarding_applications"("formId", "createdAt");

-- CreateIndex
CREATE INDEX "onboarding_applications_status_createdAt_idx" ON "onboarding_applications"("status", "createdAt");

-- CreateIndex
CREATE INDEX "onboarding_applications_email_idx" ON "onboarding_applications"("email");

-- AddForeignKey
ALTER TABLE "funnel_campaigns" ADD CONSTRAINT "funnel_campaigns_funnelId_fkey" FOREIGN KEY ("funnelId") REFERENCES "funnels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "funnel_enrollments" ADD CONSTRAINT "funnel_enrollments_funnelId_fkey" FOREIGN KEY ("funnelId") REFERENCES "funnels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_applications" ADD CONSTRAINT "onboarding_applications_formId_fkey" FOREIGN KEY ("formId") REFERENCES "onboarding_forms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Funnels are tenant data.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['funnels', 'funnel_campaigns', 'funnel_enrollments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (app_bypass() OR "organizationId" = app_org())
      WITH CHECK (app_bypass() OR "organizationId" = app_org())$p$, t);
  END LOOP;
END $$;
