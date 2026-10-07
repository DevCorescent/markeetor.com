-- CreateEnum
CREATE TYPE "CreditEntryType" AS ENUM ('PURCHASE', 'BONUS', 'WELCOME', 'GRANT', 'SPEND', 'REFUND', 'ADJUSTMENT', 'EXPIRY');

-- CreateEnum
CREATE TYPE "CreditRequestStatus" AS ENUM ('PENDING', 'AWAITING_PAYMENT', 'COMPLETED', 'REJECTED', 'CANCELLED');

-- AlterTable
ALTER TABLE "lead_requests" ADD COLUMN     "creditsCharged" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "paymentMethod" TEXT NOT NULL DEFAULT 'INVOICE';

-- CreateTable
CREATE TABLE "credit_wallets" (
    "organizationId" TEXT NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "lifetimeIn" INTEGER NOT NULL DEFAULT 0,
    "lifetimeSpent" INTEGER NOT NULL DEFAULT 0,
    "lowBalanceNotifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_wallets_pkey" PRIMARY KEY ("organizationId")
);

-- CreateTable
CREATE TABLE "credit_entries" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "type" "CreditEntryType" NOT NULL,
    "credits" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "remaining" INTEGER,
    "expiresAt" TIMESTAMP(3),
    "leadRequestId" TEXT,
    "creditRequestId" TEXT,
    "note" TEXT,
    "allocations" JSONB,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_requests" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "packageId" TEXT,
    "packageName" TEXT,
    "credits" INTEGER NOT NULL,
    "bonusCredits" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "tax" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL,
    "status" "CreditRequestStatus" NOT NULL DEFAULT 'PENDING',
    "clientNote" TEXT,
    "adminNote" TEXT,
    "paymentDetails" TEXT,
    "clientReference" TEXT,
    "paymentMethod" TEXT,
    "paymentReference" TEXT,
    "invoiceNumber" TEXT,
    "paidAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "credit_entries_organizationId_createdAt_idx" ON "credit_entries"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "credit_entries_organizationId_remaining_expiresAt_idx" ON "credit_entries"("organizationId", "remaining", "expiresAt");

-- CreateIndex
CREATE INDEX "credit_entries_leadRequestId_idx" ON "credit_entries"("leadRequestId");

-- CreateIndex
CREATE INDEX "credit_entries_creditRequestId_idx" ON "credit_entries"("creditRequestId");

-- CreateIndex
CREATE INDEX "credit_entries_type_createdAt_idx" ON "credit_entries"("type", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "credit_requests_code_key" ON "credit_requests"("code");

-- CreateIndex
CREATE UNIQUE INDEX "credit_requests_invoiceNumber_key" ON "credit_requests"("invoiceNumber");

-- CreateIndex
CREATE INDEX "credit_requests_organizationId_createdAt_idx" ON "credit_requests"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "credit_requests_status_createdAt_idx" ON "credit_requests"("status", "createdAt");

-- Credit wallets, ledger and purchase requests are tenant data: a client only ever sees its own.
ALTER TABLE credit_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_wallets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON credit_wallets
  USING (app_bypass() OR "organizationId" = app_org())
  WITH CHECK (app_bypass() OR "organizationId" = app_org());

ALTER TABLE credit_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON credit_entries
  USING (app_bypass() OR "organizationId" = app_org())
  WITH CHECK (app_bypass() OR "organizationId" = app_org());

ALTER TABLE credit_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON credit_requests
  USING (app_bypass() OR "organizationId" = app_org())
  WITH CHECK (app_bypass() OR "organizationId" = app_org());

-- A wallet can never go negative.
ALTER TABLE credit_wallets ADD CONSTRAINT credit_wallets_balance_nonnegative CHECK (balance >= 0);
