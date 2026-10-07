/**
 * Background worker: durable jobs for imports, distribution, automation, maintenance and email.
 * Run with `npm run worker` (separate process from the web server).
 */
process.env.SERVICE_NAME ??= 'leads-crm-worker';

import { Worker, type Job } from 'bullmq';
import { prisma } from '@/server/db';
import { bullConnection, queue, type QueueName } from '@/server/jobs/queues';
import { logger } from '@/server/logger';
import { redis } from '@/server/redis';
import { raiseAlert } from '@/server/security/alerts';
import { deliverEmail } from '@/server/mail';
import { executeBatch, runDueRules, runImportRules } from '@/server/services/distribution';
import { markImportFailed, purgeImportData, runProcessing, runValidation } from '@/server/services/imports';
import { runMaintenance } from '@/server/services/maintenance';
import { runAutomationScan, runScheduledReports } from '@/server/services/automation';
import { runCampaign } from '@/server/services/email';
import { announceNewLeads } from '@/server/services/announcements';
import { runFunnelAutomations } from '@/server/services/funnels';
import { enrichImport, enrichLead, failStaleEnrichment } from '@/server/services/enrichment';
import { runSavedSearches } from '@/server/services/saved-searches';
import { sendWeeklyReports } from '@/server/services/roi';
import { deliverWebhook } from '@/server/services/workspace-automation';
import { evaluateAlertRules } from '@/server/services/alerts-admin';
import { runBroadcasts } from '@/server/services/marketing';
import { runSequences } from '@/server/services/sequences';
import { handleEndpointEvent, handleImportLeadEvents, purgeEndpointData, sendEndpointMessage, sweepEndpointMessages } from '@/server/services/endpoints';

type Handler = (job: Job) => Promise<unknown>;

const handlers: Record<QueueName, Record<string, Handler>> = {
  imports: {
    validate: (job) => runValidation(job.data.importId),
    process: (job) => runProcessing(job.data.importId),
  },
  distribution: {
    execute: (job) => executeBatch(job.data.batchId),
    'on-import': (job) => runImportRules(job.data.importId),
    'rules-tick': () => runDueRules(),
  },
  automation: {
    scan: () => runAutomationScan(),
    reports: () => runScheduledReports(),
    funnels: () => runFunnelAutomations(),
    'saved-searches': () => runSavedSearches(),
    'weekly-reports': () => sendWeeklyReports(),
    webhook: (job) => deliverWebhook(job.data.deliveryId),
    'alert-rules': () => evaluateAlertRules(),
    'marketing-tick': async () => ({ sequences: await runSequences(), broadcasts: await runBroadcasts() }),
  },
  maintenance: {
    tick: () => runMaintenance(),
    'announce-new-leads': () => announceNewLeads(),
    purge: () => purgeImportData(),
  },
  enrichment: {
    lead: (job) => enrichLead(job.data.leadId, { apply: job.data.apply ?? undefined, force: job.data.force, actorId: job.data.actorId, batchId: job.data.batchId }),
    import: (job) => enrichImport(job.data.importId),
    stale: () => failStaleEnrichment(),
  },
  email: {
    deliver: (job) => deliverEmail(job.data.emailId),
    campaign: (job) => runCampaign(job.data.campaignId),
    'endpoint-message': (job) => sendEndpointMessage(job.data.messageId),
    'endpoint-event': (job) => handleEndpointEvent(job.data.event, job.data.payload, job.data.key ?? null),
    'endpoint-import': (job) => handleImportLeadEvents(job.data.importId),
    'endpoint-sweep': () => sweepEndpointMessages(),
    'endpoint-purge': () => purgeEndpointData(),
  },
};

const workers: Worker[] = [];

for (const [name, map] of Object.entries(handlers) as [QueueName, Record<string, Handler>][]) {
  const w = new Worker(
    name,
    async (job) => {
      const fn = map[job.name];
      if (!fn) throw new Error(`No handler for ${name}:${job.name}`);
      const started = Date.now();
      const res = await fn(job);
      logger.info({ queue: name, job: job.name, id: job.id, ms: Date.now() - started }, 'job completed');
      return res ?? null;
    },
    {
      connection: bullConnection(),
      prefix: process.env.QUEUE_PREFIX ?? 'lcrm',
      concurrency: name === 'distribution' ? 1 : name === 'imports' ? 2 : name === 'enrichment' ? 6 : 4,
      // Research is network-bound and polite: at most 4 leads started per second across the worker.
      ...(name === 'enrichment' ? { limiter: { max: 4, duration: 1000 } } : {}),
    },
  );
  w.on('failed', async (job, err) => {
    logger.error({ queue: name, job: job?.name, id: job?.id, attempts: job?.attemptsMade, err }, 'job failed');
    const exhausted = job && job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!exhausted) return;
    // Dead-letter handling: final failure is surfaced as a platform alert and reflected on the domain record.
    if (name === 'imports' && job?.data?.importId) await markImportFailed(job.data.importId, err.message).catch(() => null);
    await raiseAlert({
      type: 'JOB_FAILED', severity: 'MEDIUM', title: `Background job failed: ${name}/${job?.name}`,
      details: { queue: name, job: job?.name, jobId: job?.id, error: err.message.slice(0, 500), data: job?.data },
      dedupeKey: `jobfail:${name}:${job?.id}`,
    });
  });
  workers.push(w);
}

async function scheduleRepeatables() {
  await queue('maintenance').upsertJobScheduler('maintenance-tick', { every: 60_000 }, { name: 'tick', data: {} });
  await queue('maintenance').upsertJobScheduler('maintenance-purge', { pattern: '17 3 * * *' }, { name: 'purge', data: {} });
  await queue('distribution').upsertJobScheduler('rules-tick', { every: 60_000 }, { name: 'rules-tick', data: {} });
  await queue('automation').upsertJobScheduler('automation-scan', { every: 5 * 60_000 }, { name: 'scan', data: {} });
  await queue('automation').upsertJobScheduler('funnel-automations', { every: 5 * 60_000 }, { name: 'funnels', data: {} });
  await queue('enrichment').upsertJobScheduler('enrichment-stale', { every: 15 * 60_000 }, { name: 'stale', data: {} });
  await queue('automation').upsertJobScheduler('saved-searches', { every: 15 * 60_000 }, { name: 'saved-searches', data: {} });
  await queue('automation').upsertJobScheduler('marketing-tick', { every: 60_000 }, { name: 'marketing-tick', data: {} });
  await queue('automation').upsertJobScheduler('alert-rules', { every: 15 * 60_000 }, { name: 'alert-rules', data: {} });
  await queue('automation').upsertJobScheduler('weekly-reports', { pattern: '0 8 * * 1' }, { name: 'weekly-reports', data: {} });
  await queue('automation').upsertJobScheduler('scheduled-reports', { pattern: '0 7 * * *' }, { name: 'reports', data: {} });
  await queue('email').upsertJobScheduler('endpoint-sweep', { every: 60_000 }, { name: 'endpoint-sweep', data: {} });
  await queue('email').upsertJobScheduler('endpoint-purge', { pattern: '41 3 * * *' }, { name: 'endpoint-purge', data: {} });
}

const heartbeat = setInterval(() => {
  redis().set('worker:heartbeat', new Date().toISOString(), 'EX', 120).catch(() => null);
}, 15_000);

scheduleRepeatables()
  .then(() => {
    redis().set('worker:heartbeat', new Date().toISOString(), 'EX', 120).catch(() => null);
    logger.info({ queues: Object.keys(handlers) }, 'worker started');
  })
  .catch((err) => logger.error({ err }, 'failed to schedule repeatable jobs'));

async function shutdown(signal: string) {
  logger.info({ signal }, 'worker shutting down');
  clearInterval(heartbeat);
  await Promise.allSettled(workers.map((w) => w.close()));
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
