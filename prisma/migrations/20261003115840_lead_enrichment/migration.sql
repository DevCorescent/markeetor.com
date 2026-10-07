-- CreateEnum
CREATE TYPE "EnrichmentStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'PARTIAL', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "lead_enrichments" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "status" "EnrichmentStatus" NOT NULL DEFAULT 'QUEUED',
    "engine" TEXT,
    "domain" TEXT,
    "confidence" INTEGER NOT NULL DEFAULT 0,
    "data" JSONB NOT NULL DEFAULT '{}',
    "summary" TEXT,
    "sources" JSONB NOT NULL DEFAULT '[]',
    "checks" JSONB NOT NULL DEFAULT '{}',
    "applied" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "searchText" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "applyMode" TEXT NOT NULL DEFAULT 'empty',
    "batchId" TEXT,
    "requestedById" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_enrichments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domain_snapshots" (
    "domain" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "text" TEXT,
    "pages" JSONB NOT NULL DEFAULT '[]',
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "domain_snapshots_pkey" PRIMARY KEY ("domain")
);

-- CreateIndex
CREATE UNIQUE INDEX "lead_enrichments_leadId_key" ON "lead_enrichments"("leadId");

-- CreateIndex
CREATE INDEX "lead_enrichments_status_idx" ON "lead_enrichments"("status");

-- CreateIndex
CREATE INDEX "lead_enrichments_batchId_idx" ON "lead_enrichments"("batchId");

-- CreateIndex
CREATE INDEX "lead_enrichments_domain_idx" ON "lead_enrichments"("domain");

-- CreateIndex
CREATE INDEX "lead_enrichments_search_trgm" ON "lead_enrichments" USING GIN ("searchText" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "domain_snapshots_fetchedAt_idx" ON "domain_snapshots"("fetchedAt");

-- AddForeignKey
ALTER TABLE "lead_enrichments" ADD CONSTRAINT "lead_enrichments_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
