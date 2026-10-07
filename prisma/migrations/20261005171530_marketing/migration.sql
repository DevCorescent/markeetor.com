-- CreateTable
CREATE TABLE "marketing_segments" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "filter" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketing_segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sequences" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "steps" JSONB NOT NULL,
    "stopOnReply" BOOLEAN NOT NULL DEFAULT true,
    "stopOnStatus" TEXT[] DEFAULT ARRAY['CONVERTED', 'LOST']::TEXT[],
    "segmentId" TEXT,
    "autoEnroll" BOOLEAN NOT NULL DEFAULT false,
    "enrolledCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sequence_enrollments" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sequenceId" TEXT NOT NULL,
    "clientLeadId" TEXT NOT NULL,
    "stepIndex" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "nextRunAt" TIMESTAMP(3),
    "stopReason" TEXT,
    "lastError" TEXT,
    "enrolledById" TEXT,
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sequence_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_messages" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientLeadId" TEXT,
    "channel" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "provider" TEXT,
    "providerMessageId" TEXT,
    "credits" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "sequenceId" TEXT,
    "enrollmentId" TEXT,
    "broadcastId" TEXT,
    "sentById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketing_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_broadcasts" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "segmentId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "total" INTEGER NOT NULL DEFAULT 0,
    "sent" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "cursor" TEXT,
    "reviewNote" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "marketing_broadcasts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracked_links" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "uniqueLeads" INTEGER NOT NULL DEFAULT 0,
    "lastClickAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tracked_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "link_clicks" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientLeadId" TEXT,
    "referer" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "link_clicks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capture_forms" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "sequenceId" TEXT,
    "submissions" INTEGER NOT NULL DEFAULT 0,
    "views" INTEGER NOT NULL DEFAULT 0,
    "reviewNote" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "capture_forms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capture_submissions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "formId" TEXT NOT NULL,
    "clientLeadId" TEXT,
    "data" JSONB NOT NULL,
    "utm" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "capture_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_templates" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "content" JSONB NOT NULL,
    "published" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketing_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "marketing_segments_organizationId_idx" ON "marketing_segments"("organizationId");

-- CreateIndex
CREATE INDEX "sequences_organizationId_status_idx" ON "sequences"("organizationId", "status");

-- CreateIndex
CREATE INDEX "sequence_enrollments_status_nextRunAt_idx" ON "sequence_enrollments"("status", "nextRunAt");

-- CreateIndex
CREATE INDEX "sequence_enrollments_organizationId_clientLeadId_idx" ON "sequence_enrollments"("organizationId", "clientLeadId");

-- CreateIndex
CREATE UNIQUE INDEX "sequence_enrollments_sequenceId_clientLeadId_key" ON "sequence_enrollments"("sequenceId", "clientLeadId");

-- CreateIndex
CREATE INDEX "marketing_messages_organizationId_createdAt_idx" ON "marketing_messages"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "marketing_messages_providerMessageId_idx" ON "marketing_messages"("providerMessageId");

-- CreateIndex
CREATE INDEX "marketing_messages_broadcastId_idx" ON "marketing_messages"("broadcastId");

-- CreateIndex
CREATE INDEX "marketing_broadcasts_organizationId_createdAt_idx" ON "marketing_broadcasts"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "marketing_broadcasts_status_idx" ON "marketing_broadcasts"("status");

-- CreateIndex
CREATE UNIQUE INDEX "tracked_links_code_key" ON "tracked_links"("code");

-- CreateIndex
CREATE INDEX "tracked_links_organizationId_idx" ON "tracked_links"("organizationId");

-- CreateIndex
CREATE INDEX "link_clicks_linkId_createdAt_idx" ON "link_clicks"("linkId", "createdAt");

-- CreateIndex
CREATE INDEX "link_clicks_organizationId_createdAt_idx" ON "link_clicks"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "capture_forms_slug_key" ON "capture_forms"("slug");

-- CreateIndex
CREATE INDEX "capture_forms_organizationId_idx" ON "capture_forms"("organizationId");

-- CreateIndex
CREATE INDEX "capture_submissions_formId_createdAt_idx" ON "capture_submissions"("formId", "createdAt");

-- CreateIndex
CREATE INDEX "capture_submissions_organizationId_createdAt_idx" ON "capture_submissions"("organizationId", "createdAt");

-- AddForeignKey
ALTER TABLE "sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "sequences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE marketing_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_segments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON marketing_segments
  USING (app_bypass() OR "organizationId" = app_org())
  WITH CHECK (app_bypass() OR "organizationId" = app_org());

ALTER TABLE sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE sequences FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sequences
  USING (app_bypass() OR "organizationId" = app_org())
  WITH CHECK (app_bypass() OR "organizationId" = app_org());

ALTER TABLE sequence_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE sequence_enrollments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sequence_enrollments
  USING (app_bypass() OR "organizationId" = app_org())
  WITH CHECK (app_bypass() OR "organizationId" = app_org());

ALTER TABLE marketing_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON marketing_messages
  USING (app_bypass() OR "organizationId" = app_org())
  WITH CHECK (app_bypass() OR "organizationId" = app_org());

ALTER TABLE marketing_broadcasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_broadcasts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON marketing_broadcasts
  USING (app_bypass() OR "organizationId" = app_org())
  WITH CHECK (app_bypass() OR "organizationId" = app_org());

ALTER TABLE tracked_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracked_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tracked_links
  USING (app_bypass() OR "organizationId" = app_org())
  WITH CHECK (app_bypass() OR "organizationId" = app_org());

ALTER TABLE link_clicks ENABLE ROW LEVEL SECURITY;
ALTER TABLE link_clicks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON link_clicks
  USING (app_bypass() OR "organizationId" = app_org())
  WITH CHECK (app_bypass() OR "organizationId" = app_org());

ALTER TABLE capture_forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE capture_forms FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON capture_forms
  USING (app_bypass() OR "organizationId" = app_org())
  WITH CHECK (app_bypass() OR "organizationId" = app_org());

ALTER TABLE capture_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE capture_submissions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON capture_submissions
  USING (app_bypass() OR "organizationId" = app_org())
  WITH CHECK (app_bypass() OR "organizationId" = app_org());

-- The template library is read through the platform context only.
ALTER TABLE marketing_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON marketing_templates USING (app_bypass()) WITH CHECK (app_bypass());
