import type { AuthContext } from '../auth/context';
import { audit } from '../audit';
import { prisma, withPlatform } from '../db';
import { AppError } from '../errors';
import { queue, QUEUE_NAMES, type QueueName } from '../jobs/queues';
import { redis } from '../redis';

/** System health for the platform team: worker, queues, failed jobs, email, webhooks, research and payments. */
export async function systemHealth() {
  const since = new Date(Date.now() - 24 * 3_600_000);
  const started = Date.now();
  const dbOk = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
  const dbMs = Date.now() - started;
  const heartbeat = await redis().get('worker:heartbeat').catch(() => null);
  const redisOk = await redis().ping().then((p) => p === 'PONG').catch(() => false);
  const queues = await Promise.all(QUEUE_NAMES.map(async (name) => {
    const c = await queue(name).getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed').catch(() => null);
    return { name, ...(c ?? { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 }), reachable: Boolean(c) };
  }));
  const failed = (await Promise.all(QUEUE_NAMES.map(async (name) => {
    const jobs = await queue(name).getFailed(0, 9).catch(() => []);
    return jobs.map((j) => ({ queue: name, id: j.id ?? '', name: j.name, attempts: j.attemptsMade, reason: (j.failedReason ?? '').slice(0, 300), at: j.finishedOn ? new Date(j.finishedOn).toISOString() : null }));
  }))).flat().sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 30);
  const [emails, webhooks, enrichment, payments, alerts] = await withPlatform((tx) => Promise.all([
    tx.outboundEmail.groupBy({ by: ['status'], where: { createdAt: { gte: since } }, _count: true }),
    tx.webhookDelivery.groupBy({ by: ['status'], where: { createdAt: { gte: since } }, _count: true }),
    tx.leadEnrichment.groupBy({ by: ['status'], where: { updatedAt: { gte: since } }, _count: true }),
    tx.paymentOrder.groupBy({ by: ['status'], where: { createdAt: { gte: since } }, _count: true }),
    tx.alertRuleEvent.count({ where: { createdAt: { gte: since } } }),
  ]));
  const toMap = (rows: { status: string; _count: number }[]) => Object.fromEntries(rows.map((r) => [r.status, r._count]));
  const hbAge = heartbeat ? Math.round((Date.now() - new Date(heartbeat).getTime()) / 1000) : null;
  return {
    checkedAt: new Date().toISOString(),
    services: {
      database: { ok: dbOk, ms: dbMs },
      redis: { ok: redisOk },
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
  const job = await queue(name).getJob(id);
  if (!job) throw new AppError('NOT_FOUND', 'Job not found');
  await job.retry('failed');
  await withPlatform((tx) => audit(tx, ctx, { action: 'system.job.retried', targetType: 'job', targetId: `${name}:${id}`, organizationId: null }));
  return { ok: true };
}

export async function retryAllFailed(ctx: AuthContext, name: QueueName) {
  if (!QUEUE_NAMES.includes(name)) throw new AppError('VALIDATION_FAILED', 'Unknown queue');
  const jobs = await queue(name).getFailed(0, 199);
  for (const j of jobs) await j.retry('failed').catch(() => null);
  await withPlatform((tx) => audit(tx, ctx, { action: 'system.jobs.retried', targetType: 'queue', targetId: name, organizationId: null, metadata: { count: jobs.length } }));
  return { retried: jobs.length };
}
