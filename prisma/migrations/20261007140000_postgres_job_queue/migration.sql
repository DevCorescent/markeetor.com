-- Postgres-backed background job queue, replacing Redis + BullMQ.
--
-- Jobs are claimed with SELECT ... FOR UPDATE SKIP LOCKED, so many workers can run
-- concurrently without coordination. `dedupeKey` carries the idempotency guarantee the
-- former BullMQ `jobId` provided.
--
-- Row-level security is deliberately NOT enabled on these four tables, matching the
-- existing carve-out for `users` / `sessions` / `memberships` (see src/server/db.ts):
-- they hold no tenant-owned rows, `enqueue()` runs on tenant request paths that carry
-- no RLS bypass, and the only reader is the platform-scoped `system.manage` surface.

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'ACTIVE', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL,
    "queue" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "backoffMs" INTEGER NOT NULL DEFAULT 5000,
    "dedupeKey" TEXT,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_schedules" (
    "key" TEXT NOT NULL,
    "queue" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "everyMs" INTEGER,
    "cron" TEXT,
    "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastRunAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_schedules_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "rate_limit_counters" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rate_limit_counters_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "service_heartbeats" (
    "name" TEXT NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL,
    "meta" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "service_heartbeats_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE UNIQUE INDEX "jobs_dedupeKey_key" ON "jobs"("dedupeKey");

-- CreateIndex
CREATE INDEX "jobs_status_runAt_idx" ON "jobs"("status", "runAt");

-- CreateIndex
CREATE INDEX "jobs_queue_status_runAt_idx" ON "jobs"("queue", "status", "runAt");

-- CreateIndex
CREATE INDEX "jobs_status_finishedAt_idx" ON "jobs"("status", "finishedAt");

-- CreateIndex
CREATE INDEX "job_schedules_nextRunAt_idx" ON "job_schedules"("nextRunAt");

-- CreateIndex
CREATE INDEX "rate_limit_counters_expiresAt_idx" ON "rate_limit_counters"("expiresAt");

