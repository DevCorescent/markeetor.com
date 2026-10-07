-- CreateTable
CREATE TABLE "company_registry_records" (
    "id" TEXT NOT NULL,
    "regId" TEXT,
    "nameKey" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_registry_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "company_registry_records_regId_key" ON "company_registry_records"("regId");

-- CreateIndex
CREATE INDEX "company_registry_records_nameKey_idx" ON "company_registry_records"("nameKey");
