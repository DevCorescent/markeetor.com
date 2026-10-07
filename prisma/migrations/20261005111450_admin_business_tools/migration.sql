-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "billingState" TEXT,
ADD COLUMN     "gstin" TEXT;

-- CreateTable
CREATE TABLE "lead_suppliers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "sources" TEXT[],
    "costPerLead" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_search_logs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conditions" JSONB NOT NULL,
    "industries" TEXT[],
    "locations" TEXT[],
    "keywords" TEXT[],
    "results" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_search_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_rules" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "threshold" DECIMAL(14,2) NOT NULL,
    "params" JSONB NOT NULL DEFAULT '{}',
    "cooldownHours" INTEGER NOT NULL DEFAULT 24,
    "email" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastFiredAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alert_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_rule_events" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "value" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_rule_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_invoices" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "fy" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "currency" TEXT NOT NULL,
    "seller" JSONB NOT NULL,
    "buyer" JSONB NOT NULL,
    "lines" JSONB NOT NULL,
    "taxable" DECIMAL(14,2) NOT NULL,
    "cgst" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "sgst" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "igst" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL,
    "paid" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "tax_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_orders" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'razorpay',
    "providerOrderId" TEXT NOT NULL,
    "providerPaymentId" TEXT,
    "creditRequestId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CREATED',
    "error" TEXT,
    "createdById" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "market_search_logs_createdAt_idx" ON "market_search_logs"("createdAt");

-- CreateIndex
CREATE INDEX "market_search_logs_organizationId_createdAt_idx" ON "market_search_logs"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "alert_rule_events_ruleId_createdAt_idx" ON "alert_rule_events"("ruleId", "createdAt");

-- CreateIndex
CREATE INDEX "alert_rule_events_createdAt_idx" ON "alert_rule_events"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "tax_invoices_number_key" ON "tax_invoices"("number");

-- CreateIndex
CREATE INDEX "tax_invoices_organizationId_issuedAt_idx" ON "tax_invoices"("organizationId", "issuedAt");

-- CreateIndex
CREATE UNIQUE INDEX "tax_invoices_fy_seq_key" ON "tax_invoices"("fy", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "tax_invoices_kind_refId_key" ON "tax_invoices"("kind", "refId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_orders_providerOrderId_key" ON "payment_orders"("providerOrderId");

-- CreateIndex
CREATE INDEX "payment_orders_creditRequestId_idx" ON "payment_orders"("creditRequestId");

-- CreateIndex
CREATE INDEX "payment_orders_organizationId_createdAt_idx" ON "payment_orders"("organizationId", "createdAt");

-- AddForeignKey
ALTER TABLE "alert_rule_events" ADD CONSTRAINT "alert_rule_events_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "alert_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE market_search_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_search_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON market_search_logs
  USING (app_bypass() OR "organizationId" = app_org())
  WITH CHECK (app_bypass() OR "organizationId" = app_org());

ALTER TABLE tax_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tax_invoices
  USING (app_bypass() OR "organizationId" = app_org())
  WITH CHECK (app_bypass() OR "organizationId" = app_org());

ALTER TABLE payment_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_orders
  USING (app_bypass() OR "organizationId" = app_org())
  WITH CHECK (app_bypass() OR "organizationId" = app_org());

ALTER TABLE lead_suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_suppliers FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON lead_suppliers USING (app_bypass()) WITH CHECK (app_bypass());

ALTER TABLE alert_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON alert_rules USING (app_bypass()) WITH CHECK (app_bypass());

ALTER TABLE alert_rule_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_rule_events FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON alert_rule_events USING (app_bypass()) WITH CHECK (app_bypass());
