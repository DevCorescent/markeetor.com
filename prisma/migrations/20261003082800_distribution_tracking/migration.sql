-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "distributionCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastDistributedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "leads_distributionCount_idx" ON "leads"("distributionCount");

-- CreateIndex
CREATE INDEX "leads_lastDistributedAt_idx" ON "leads"("lastDistributedAt");

-- Backfill from existing assignment history.
UPDATE "leads" AS l
SET "distributionCount" = a.n, "lastDistributedAt" = a.last
FROM (SELECT "leadId", count(*)::int AS n, max("assignedAt") AS last FROM "lead_assignments" GROUP BY "leadId") AS a
WHERE l.id = a."leadId";

-- Analytics access paths.
CREATE INDEX IF NOT EXISTS "lead_assignments_assignedAt_idx" ON "lead_assignments" ("assignedAt");
CREATE INDEX IF NOT EXISTS "lead_assignments_lead_org_idx" ON "lead_assignments" ("leadId", "organizationId");
