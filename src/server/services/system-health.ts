import type { AuthContext } from '../auth/context';
import { audit } from '../audit';
import { prisma, withPlatform } from '../db';
import { AppError } from '../errors';
import { failedJobs, lastHeartbeat, queueCounts, QUEUE_NAMES, retryJob, retryQueue, type QueueName } from '../jobs/queues';

const WORKER_NAME = process.env.WORKER_SERVICE_NAME ?? 'leads-crm-worker';

/** System health for the platform team: worker, queues, failed jobs, email, webhooks, research and payments. */
export async function systemHealth() {
  const since = new Date(Date.now() - 24 * 3_600_000);
  const started = Date.now();
  const dbOk = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
  const dbMs = Date.now() - started;
  const heartbeat = await lastHeartbeat(WORKER_NAME).catch(() => null);
  const counts = await queueCounts().catch(() => null);
  const queues = QUEUE_NAMES.map((name) => ({
    name,
    ...(counts?.[name] ?? { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 }),
    reachable: Boolean(counts),
  }));
  const failed = await failedJobs(30).catch(() => []);
  const [emails, webhooks, enrichment, payments, alerts] = await withPlatform((tx) => Promise.all([
    tx.outboundEmail.groupBy({ by: ['status'], where: { createdAt: { gte: since } }, _count: true }),
    tx.webhookDelivery.groupBy({ by: ['status'], where: { createdAt: { gte: since } }, _count: true }),
    tx.leadEnrichment.groupBy({ by: ['status'], where: { updatedAt: { gte: since } }, _count: true }),
    tx.paymentOrder.groupBy({ by: ['status'], where: { createdAt: { gte: since } }, _count: true }),
    tx.alertRuleEvent.count({ where: { createdAt: { gte: since } } }),
  ]));
  const toMap = (rows: { status: string; _count: number }[]) => Object.fromEntries(rows.map((r) => [r.status, r._count]));
  const hbAge = heartbeat ? Math.round((Date.now() - heartbeat.getTime()) / 1000) : null;
  return {
    checkedAt: new Date().toISOString(),
    services: {
      database: { ok: dbOk, ms: dbMs },
      worker: { ok: hbAge != null && hbAge < 120, lastSeenSeconds: hbAge },
      ai: { configured: Boolean(process.env.AI_PROVIDER_API_KEY) },
      smtp: { configured: Boolean(process.env.SMTP_URL) },
      razorpay: { configured: Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET), webhook: Boolean(process.env.RAZORPAY_WEBHOOK_SECRET) },
    },
    queues, failed,
    last24h: { emails: toMap(emails), webhooks: toMap(webhooks), enrichment: toMap(enrichment), payments: toMap(payments), alerts },
  };
}

export async function retryFailedJob(ctx: AuthContext, name: QueueName, id: string) {
  if (!QUEUE_NAMES.includes(name)) throw new AppError('VALIDATION_FAILED', 'Unknown queue');
  if (!(await retryJob(name, id))) throw new AppError('NOT_FOUND', 'Job not found');
  await withPlatform((tx) => audit(tx, ctx, { action: 'system.job.retried', targetType: 'job', targetId: `${name}:${id}`, organizationId: null }));
  return { ok: true };
}

export async function retryAllFailed(ctx: AuthContext, name: QueueName) {
  if (!QUEUE_NAMES.includes(name)) throw new AppError('VALIDATION_FAILED', 'Unknown queue');
  const retried = await retryQueue(name);
  await withPlatform((tx) => audit(tx, ctx, { action: 'system.jobs.retried', targetType: 'queue', targetId: name, organizationId: null, metadata: { count: retried } }));
  return { retried };
}
