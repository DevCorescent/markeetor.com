/**
 * Background worker: durable jobs for imports, distribution, automation, maintenance and email.
 * Run with `npm run worker` (separate process from the web server).
 *
 * Backed by Postgres (see src/server/jobs/queues.ts), not Redis. The loop claims due jobs
 * with FOR UPDATE SKIP LOCKED, so running several worker processes is safe and needs no
 * coordination. Per-queue concurrency is enforced by how many jobs each tick claims.
 */
process.env.SERVICE_NAME ??= 'leads-crm-worker';

import { randomUUID } from 'node:crypto';
import { prisma } from '@/server/db';
import {
  claimJobs,
  completeJob,
  failJob,
  pruneJobs,
  QUEUE_NAMES,
  reclaimStalled,
  recordHeartbeat,
  runDueSchedules,
  upsertSchedule,
  type ClaimedJob,
  type QueueName,
} from '@/server/jobs/queues';
import { logger } from '@/server/logger';
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

type Handler = (payload: Record<string, unknown>) => Promise<unknown>;

const handlers: Record<QueueName, Record<string, Handler>> = {
  imports: {
    validate: (p) => runValidation(p.importId as string),
    process: (p) => runProcessing(p.importId as string),
  },
  distribution: {
    execute: (p) => executeBatch(p.batchId as string),
    'on-import': (p) => runImportRules(p.importId as string),
    'rules-tick': () => runDueRules(),
  },
  automation: {
    scan: () => runAutomationScan(),
    reports: () => runScheduledReports(),
    funnels: () => runFunnelAutomations(),
    'saved-searches': () => runSavedSearches(),
    'weekly-reports': () => sendWeeklyReports(),
    webhook: (p) => deliverWebhook(p.deliveryId as string),
    'alert-rules': () => evaluateAlertRules(),
    'marketing-tick': async () => ({ sequences: await runSequences(), broadcasts: await runBroadcasts() }),
  },
  maintenance: {
    tick: () => runMaintenance(),
    'announce-new-leads': () => announceNewLeads(),
    purge: () => purgeImportData(),
  },
  enrichment: {
    lead: (p) =>
      enrichLead(p.leadId as string, {
        apply: (p.apply ?? undefined) as never,
        force: p.force as boolean | undefined,
        actorId: p.actorId as string,
        batchId: p.batchId as string,
      }),
    import: (p) => enrichImport(p.importId as string),
    stale: () => failStaleEnrichment(),
  },
  email: {
    deliver: (p) => deliverEmail(p.emailId as string),
    campaign: (p) => runCampaign(p.campaignId as string),
    'endpoint-message': (p) => sendEndpointMessage(p.messageId as string),
    'endpoint-event': (p) => handleEndpointEvent(p.event as string, p.payload as never, (p.key ?? null) as string | null),
    'endpoint-import': (p) => handleImportLeadEvents(p.importId as string),
    'endpoint-sweep': () => sweepEndpointMessages(),
    'endpoint-purge': () => purgeEndpointData(),
  },
};

/** How many jobs of each queue may run at once, mirroring the former BullMQ concurrency. */
const CONCURRENCY: Record<QueueName, number> = {
  imports: 2,
  distribution: 1,
  automation: 4,
  maintenance: 4,
  email: 4,
  enrichment: 6,
};

const WORKER_ID = `${process.env.SERVICE_NAME}:${process.pid}:${randomUUID().slice(0, 8)}`;
const POLL_MS = Number(process.env.JOB_POLL_MS ?? 2_000);

/** Jobs currently running, per queue, so a tick never exceeds the concurrency budget. */
const running = new Map<QueueName, number>(QUEUE_NAMES.map((q) => [q, 0]));
let shuttingDown = false;

async function runJob(job: ClaimedJob) {
  const started = Date.now();
  const fn = handlers[job.queue]?.[job.name];
  try {
    if (!fn) throw new Error(`No handler for ${job.queue}:${job.name}`);
    await fn(job.payload);
    await completeJob(job.id);
    logger.info({ queue: job.queue, job: job.name, id: job.id, ms: Date.now() - started }, 'job completed');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const exhausted = await failJob(job, message).catch(() => false);
    logger.error({ queue: job.queue, job: job.name, id: job.id, attempts: job.attempts, err }, 'job failed');
    if (!exhausted) return;
    // Dead-letter handling: final failure is surfaced as a platform alert and reflected on the domain record.
    if (job.queue === 'imports' && job.payload.importId) {
      await markImportFailed(job.payload.importId as string, message).catch(() => null);
    }
    await raiseAlert({
      type: 'JOB_FAILED',
      severity: 'MEDIUM',
      title: `Background job failed: ${job.queue}/${job.name}`,
      details: { queue: job.queue, job: job.name, jobId: job.id, error: message.slice(0, 500), data: job.payload },
      dedupeKey: `jobfail:${job.queue}:${job.id}`,
    }).catch((err) => logger.error({ err }, 'could not raise job failure alert'));
  } finally {
    running.set(job.queue, Math.max(0, (running.get(job.queue) ?? 1) - 1));
  }
}

/** Claims whatever each queue has spare capacity for and starts it without awaiting. */
async function tick() {
  const hungry = QUEUE_NAMES.filter((q) => (running.get(q) ?? 0) < CONCURRENCY[q]);
  if (!hungry.length) return;
  // Claim per queue so one busy queue cannot starve the others of its budget.
  for (const queue of hungry) {
    const capacity = CONCURRENCY[queue] - (running.get(queue) ?? 0);
    const jobs = await claimJobs([queue], capacity, WORKER_ID);
    for (const job of jobs) {
      running.set(queue, (running.get(queue) ?? 0) + 1);
      void runJob(job);
    }
  }
}

async function registerSchedules() {
  await upsertSchedule('maintenance-tick', { queue: 'maintenance', name: 'tick', everyMs: 60_000 });
  await upsertSchedule('maintenance-purge', { queue: 'maintenance', name: 'purge', cron: '17 3 * * *' });
  await upsertSchedule('rules-tick', { queue: 'distribution', name: 'rules-tick', everyMs: 60_000 });
  await upsertSchedule('automation-scan', { queue: 'automation', name: 'scan', everyMs: 5 * 60_000 });
  await upsertSchedule('funnel-automations', { queue: 'automation', name: 'funnels', everyMs: 5 * 60_000 });
  await upsertSchedule('enrichment-stale', { queue: 'enrichment', name: 'stale', everyMs: 15 * 60_000 });
  await upsertSchedule('saved-searches', { queue: 'automation', name: 'saved-searches', everyMs: 15 * 60_000 });
  await upsertSchedule('marketing-tick', { queue: 'automation', name: 'marketing-tick', everyMs: 60_000 });
  await upsertSchedule('alert-rules', { queue: 'automation', name: 'alert-rules', everyMs: 15 * 60_000 });
  await upsertSchedule('weekly-reports', { queue: 'automation', name: 'weekly-reports', cron: '0 8 * * 1' });
  await upsertSchedule('scheduled-reports', { queue: 'automation', name: 'reports', cron: '0 7 * * *' });
  await upsertSchedule('endpoint-sweep', { queue: 'email', name: 'endpoint-sweep', everyMs: 60_000 });
  await upsertSchedule('endpoint-purge', { queue: 'email', name: 'endpoint-purge', cron: '41 3 * * *' });
}

/**
 * Repeats `fn` every `everyMs` until shutdown, logging rather than throwing.
 *
 * The timers are deliberately NOT unref'd: they are the only thing keeping the event loop
 * alive between jobs. Unref'ing them lets node exit as soon as the queue goes idle, which
 * looks like the worker crash-looping under a supervisor — it starts, drains what is due,
 * exits cleanly, and gets restarted.
 */
function every(everyMs: number, label: string, fn: () => Promise<unknown>) {
  return setInterval(() => {
    if (shuttingDown) return;
    void fn().catch((err) => logger.error({ err, task: label }, 'worker task failed'));
  }, everyMs);
}

async function main() {
  await registerSchedules();
  await recordHeartbeat(process.env.SERVICE_NAME!, { workerId: WORKER_ID, queues: QUEUE_NAMES });
  logger.info({ queues: QUEUE_NAMES, workerId: WORKER_ID, pollMs: POLL_MS }, 'worker started');

  const timers = [
    every(POLL_MS, 'poll', tick),
    every(60_000, 'schedules', runDueSchedules),
    every(15_000, 'heartbeat', () => recordHeartbeat(process.env.SERVICE_NAME!, { workerId: WORKER_ID })),
    every(60_000, 'reclaim', () => reclaimStalled()),
    every(6 * 3_600_000, 'prune', () => pruneJobs()),
  ];

  // Fire the schedule tick once at boot so a timer that came due while the worker was
  // down runs immediately rather than waiting a full minute.
  await runDueSchedules().catch((err) => logger.error({ err }, 'initial schedule tick failed'));

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'worker shutting down');
    for (const t of timers) clearInterval(t);
    // Let in-flight handlers finish so their jobs are not left ACTIVE for the reclaimer.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && [...running.values()].some((n) => n > 0)) {
      await new Promise((r) => setTimeout(r, 200));
    }
    await prisma.$disconnect().catch(() => null);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'worker failed to start');
  process.exit(1);
});
