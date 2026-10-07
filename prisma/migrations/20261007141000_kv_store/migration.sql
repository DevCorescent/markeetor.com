-- CreateTable
CREATE TABLE "kv_store" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kv_store_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "kv_store_expiresAt_idx" ON "kv_store"("expiresAt");

