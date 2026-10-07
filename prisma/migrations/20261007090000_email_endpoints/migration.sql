-- AlterTable
ALTER TABLE "email_messages" ADD COLUMN     "bcc" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "cc" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "clickCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "clickedAt" TIMESTAMP(3),
ADD COLUMN     "endpointEventId" TEXT,
ADD COLUMN     "endpointId" TEXT,
ADD COLUMN     "scheduledFor" TIMESTAMP(3),
ADD COLUMN     "stepIndex" INTEGER,
ADD COLUMN     "vars" JSONB;

-- CreateTable
CREATE TABLE "email_message_events" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "detail" TEXT,
    "url" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_message_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_endpoints" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "triggerType" TEXT NOT NULL,
    "event" TEXT,
    "tokenHash" TEXT,
    "tokenPreview" TEXT,
    "signingSecretEnc" TEXT,
    "category" TEXT NOT NULL DEFAULT 'TRANSACTIONAL',
    "smtpAccountId" TEXT,
    "config" JSONB NOT NULL,
    "lastTriggeredAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "email_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_endpoint_events" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "idempotencyKey" TEXT,
    "payload" JSONB,
    "recipients" INTEGER NOT NULL DEFAULT 0,
    "messages" INTEGER NOT NULL DEFAULT 0,
    "ip" TEXT,
    "replayOfId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_endpoint_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_message_events_messageId_createdAt_idx" ON "email_message_events"("messageId", "createdAt");

-- CreateIndex
CREATE INDEX "email_message_events_type_createdAt_idx" ON "email_message_events"("type", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "email_endpoints_slug_key" ON "email_endpoints"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "email_endpoints_tokenHash_key" ON "email_endpoints"("tokenHash");

-- CreateIndex
CREATE INDEX "email_endpoints_triggerType_event_status_idx" ON "email_endpoints"("triggerType", "event", "status");

-- CreateIndex
CREATE INDEX "email_endpoint_events_endpointId_createdAt_idx" ON "email_endpoint_events"("endpointId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "email_endpoint_events_endpointId_idempotencyKey_key" ON "email_endpoint_events"("endpointId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "email_messages_endpointId_createdAt_idx" ON "email_messages"("endpointId", "createdAt");

-- CreateIndex
CREATE INDEX "email_messages_toEmail_idx" ON "email_messages"("toEmail");

-- AddForeignKey
ALTER TABLE "email_message_events" ADD CONSTRAINT "email_message_events_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "email_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_endpoint_events" ADD CONSTRAINT "email_endpoint_events_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "email_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Platform-only tables: readable and writable only from platform (bypass) transactions.
ALTER TABLE email_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_endpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON email_endpoints USING (app_bypass()) WITH CHECK (app_bypass());

ALTER TABLE email_endpoint_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_endpoint_events FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON email_endpoint_events USING (app_bypass()) WITH CHECK (app_bypass());

ALTER TABLE email_message_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_message_events FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON email_message_events USING (app_bypass()) WITH CHECK (app_bypass());
