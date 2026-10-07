-- CreateEnum
CREATE TYPE "LeadRequestStatus" AS ENUM ('PENDING', 'FULFILLED', 'PARTIAL', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BillingStatus" AS ENUM ('NONE', 'DUE', 'PAID', 'WAIVED', 'VOID');

-- CreateTable
CREATE TABLE "lead_requests" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "status" "LeadRequestStatus" NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "adminNote" TEXT,
    "leadCount" INTEGER NOT NULL,
    "deliveredCount" INTEGER NOT NULL DEFAULT 0,
    "freeApplied" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "subtotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "discount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "tax" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "quote" JSONB NOT NULL,
    "billingStatus" "BillingStatus" NOT NULL DEFAULT 'NONE',
    "invoiceNumber" TEXT,
    "paidAt" TIMESTAMP(3),
    "batchId" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_request_items" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "free" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',

    CONSTRAINT "lead_request_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcements" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "link" TEXT,
    "audience" JSONB NOT NULL,
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "orgCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lead_requests_code_key" ON "lead_requests"("code");

-- CreateIndex
CREATE UNIQUE INDEX "lead_requests_invoiceNumber_key" ON "lead_requests"("invoiceNumber");

-- CreateIndex
CREATE INDEX "lead_requests_organizationId_createdAt_idx" ON "lead_requests"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "lead_requests_status_createdAt_idx" ON "lead_requests"("status", "createdAt");

-- CreateIndex
CREATE INDEX "lead_request_items_leadId_idx" ON "lead_request_items"("leadId");

-- CreateIndex
CREATE INDEX "lead_request_items_organizationId_idx" ON "lead_request_items"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "lead_request_items_requestId_leadId_key" ON "lead_request_items"("requestId", "leadId");

-- CreateIndex
CREATE INDEX "announcements_createdAt_idx" ON "announcements"("createdAt");

-- AddForeignKey
ALTER TABLE "lead_request_items" ADD CONSTRAINT "lead_request_items_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "lead_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation: clients only ever see their own requests and request items.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['lead_requests', 'lead_request_items'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (app_bypass() OR "organizationId" = app_org())
      WITH CHECK (app_bypass() OR "organizationId" = app_org())$p$, t);
  END LOOP;
END $$;

-- A lead can be in at most one open (REQUESTED) request at a time.
CREATE UNIQUE INDEX lead_request_items_one_open ON lead_request_items ("leadId") WHERE status = 'REQUESTED';
