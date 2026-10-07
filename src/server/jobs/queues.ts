/**
 * Postgres-backed job queue. Replaces Redis + BullMQ.
 *
 * Workers claim rows with `SELECT ... FOR UPDATE SKIP LOCKED`, which is the standard
 * Postgres queue primitive: concurrent workers never hand each other the same job and
 * never block on one another. A crashed worker's jobs are recovered by `reclaimStalled`,
 * so nothing is lost without an explicit failure.
 *
 * Retained from the BullMQ contract so call sites did not have to change:
 *   - `enqueue(queue, name, data, opts)` with `jobId` (idempotency), `delay`, `attempts`
 *     and `backoff.delay`.
 *   - `enqueue` returns `null` under NODE_ENV=test + INLINE_JOBS=1, which several callers
 *     use as the signal to run the work inline instead.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { nextCronRun } from './cron';

export const QUEUE_NAMES = ['imports', 'distribution', 'automation', 'maintenance', 'email', 'enrichment'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

export type JobsOptions = {
  /** Idempotency key. A second enqueue with the same key is dropped while the first row exists. */
  jobId?: string;
  /** Milliseconds to wait before the job becomes eligible to run. */
  delay?: number;
  attempts?: number;
  backoff?: { type?: string; delay?: number };
};

export type ClaimedJob = {
  id: string;
  queue: QueueName;
  name: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  backoffMs: number;
};

const inlineMode = () => process.env.NODE_ENV === 'test' && process.env.INLINE_JOBS === '1';

/**
 * Durable enqueue. Pass a deterministic `jobId` to make enqueueing idempotent.
 * Returns `{ id }`, or `null` in inline test mode so the caller can run the work directly.
 */
export async function enqueue(
  queue: QueueName,
  jobName: string,
  data: Record<string, unknown>,
  opts: JobsOptions = {},
): Promise<{ id: string } | null> {
  if (inlineMode()) return null;
  const row = {
    queue,
    name: jobName,
    payload: data as Prisma.InputJsonValue,
    runAt: new Date(Date.now() + Math.max(0, opts.delay ?? 0)),
    maxAttempts: opts.attempts ?? 3,
    backoffMs: opts.backoff?.delay ?? 5_000,
    dedupeKey: opts.jobId ?? null,
  };

  if (!row.dedupeKey) {
    return prisma.job.create({ data: row, select: { id: true } });
  }

  // With a dedupe key, insert via createMany + skipDuplicates rather than catching a
  // unique violation: a conflict is the normal, expected path here (that is the whole
  // point of the key), and letting Prisma throw would log `prisma:error` on every
  // deduplicated enqueue and bury real errors.
  await prisma.job.createMany({ data: [row], skipDuplicates: true });
  return prisma.job.findUnique({ where: { dedupeKey: row.dedupeKey }, select: { id: true } });
}

/** Bulk enqueue for fan-out (lead enrichment). Duplicate dedupe keys are skipped. */
export async function enqueueBulk(
  queue: QueueName,
  items: { name: string; data: Record<string, unknown>; opts?: JobsOptions }[],
): Promise<number> {
  if (inlineMode() || !items.length) return 0;
  const now = Date.now();
  const res = await prisma.job.createMany({
    data: items.map((it) => ({
      queue,
      name: it.name,
      payload: it.data as Prisma.InputJsonValue,
      runAt: new Date(now + Math.max(0, it.opts?.delay ?? 0)),
      maxAttempts: it.opts?.attempts ?? 3,
      backoffMs: it.opts?.backoff?.delay ?? 5_000,
      dedupeKey: it.opts?.jobId ?? null,
    })),
    skipDuplicates: true,
  });
  return res.count;
}

// ── Worker side ────────────────────────────────────────────────────────────

/**
 * Atomically claims up to `limit` due jobs for the given queues and marks them ACTIVE.
 * `SKIP LOCKED` means a concurrent worker simply takes different rows.
 */
export async function claimJobs(queues: readonly QueueName[], limit: number, workerId: string): Promise<ClaimedJob[]> {
  if (!queues.length || limit < 1) return [];
  const rows = await prisma.$queryRaw<
    { id: string; queue: string; name: string; payload: unknown; attempts: number; maxAttempts: number; backoffMs: number }[]
  >`
    WITH due AS (
      SELECT "id" FROM "jobs"
      WHERE "status" = 'PENDING'
        AND "runAt" <= now()
        AND "queue" IN (${Prisma.join(queues as unknown as string[])})
      ORDER BY "runAt"
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    UPDATE "jobs" j
       SET "status"   = 'ACTIVE',
           "attempts" = j."attempts" + 1,
           "lockedAt" = now(),
           "lockedBy" = ${workerId},
           "startedAt" = COALESCE(j."startedAt", now())
      FROM due
     WHERE j."id" = due."id"
    RETURNING j."id", j."queue", j."name", j."payload", j."attempts", j."maxAttempts", j."backoffMs"
  `;
  return rows.map((r) => ({
    id: r.id,
    queue: r.queue as QueueName,
    name: r.name,
    payload: (r.payload ?? {}) as Record<string, unknown>,
    attempts: r.attempts,
    maxAttempts: r.maxAttempts,
    backoffMs: r.backoffMs,
  }));
}

export async function completeJob(id: string) {
  await prisma.job.update({
    where: { id },
    data: { status: 'COMPLETED', finishedAt: new Date(), lockedAt: null, lockedBy: null, lastError: null, dedupeKey: null },
  });
}

/**
 * Records a failure. Returns `true` when the job has exhausted its attempts (the caller
 * then raises the platform alert and marks the domain record failed).
 */
export async function failJob(job: ClaimedJob, message: string): Promise<boolean> {
  const exhausted = job.attempts >= job.maxAttempts;
  if (exhausted) {
    await prisma.job.update({
      where: { id: job.id },
      data: { status: 'FAILED', finishedAt: new Date(), lockedAt: null, lockedBy: null, lastError: message.slice(0, 2_000) },
    });
    return true;
  }
  // Exponential backoff, matching the former BullMQ setting (base * 2^(attempts-1)).
  const delay = job.backoffMs * 2 ** Math.max(0, job.attempts - 1);
  await prisma.job.update({
    where: { id: job.id },
    data: {
      status: 'PENDING',
      runAt: new Date(Date.now() + delay),
      lockedAt: null,
      lockedBy: null,
      lastError: message.slice(0, 2_000),
    },
  });
  return false;
}

/**
 * Returns ACTIVE jobs whose lock has gone stale (worker killed mid-run) to PENDING.
 * Attempts already counted, so a job that repeatedly kills its worker still exhausts.
 */
export async function reclaimStalled(olderThanMs = 5 * 60_000): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const res = await prisma.job.updateMany({
    where: { status: 'ACTIVE', lockedAt: { lt: cutoff } },
    data: { status: 'PENDING', lockedAt: null, lockedBy: null, lastError: 'Reclaimed after worker stall' },
  });
  return res.count;
}

/** Deletes finished jobs, bounding table growth (the former removeOnComplete/Fail). */
export async function pruneJobs(completedAfterMs = 24 * 3_600_000, failedAfterMs = 14 * 24 * 3_600_000) {
  const now = Date.now();
  const [completed, failed] = await Promise.all([
    prisma.job.deleteMany({ where: { status: 'COMPLETED', finishedAt: { lt: new Date(now - completedAfterMs) } } }),
    prisma.job.deleteMany({ where: { status: 'FAILED', finishedAt: { lt: new Date(now - failedAfterMs) } } }),
  ]);
  return { completed: completed.count, failed: failed.count };
}

// ── Schedules (repeatable jobs) ────────────────────────────────────────────

type ScheduleSpec = { queue: QueueName; name: string; payload?: Record<string, unknown>; everyMs?: number; cron?: string };

/** Idempotently registers a repeatable schedule. Safe to call on every worker boot. */
export async function upsertSchedule(key: string, spec: ScheduleSpec) {
  if (!spec.everyMs && !spec.cron) throw new Error(`Schedule "${key}" needs everyMs or cron`);
  if (spec.everyMs && spec.cron) throw new Error(`Schedule "${key}" cannot set both everyMs and cron`);
  const next = spec.cron ? nextCronRun(spec.cron) : new Date(Date.now() + spec.everyMs!);
  const shape = {
    queue: spec.queue,
    name: spec.name,
    payload: (spec.payload ?? {}) as Prisma.InputJsonValue,
    everyMs: spec.everyMs ?? null,
    cron: spec.cron ?? null,
  };
  await prisma.jobSchedule.upsert({
    where: { key },
    create: { key, ...shape, nextRunAt: next },
    // Leave nextRunAt alone on update so a restart loop cannot postpone a due timer forever.
    update: shape,
  });
}

/**
 * Enqueues one job for every schedule that is due and advances its next run.
 * The dedupe key pins each firing to its scheduled minute, so two workers racing
 * here still produce exactly one job.
 */
export async function runDueSchedules(): Promise<number> {
  const due = await prisma.jobSchedule.findMany({ where: { nextRunAt: { lte: new Date() } } });
  let fired = 0;
  for (const s of due) {
    const slot = Math.floor(s.nextRunAt.getTime() / 60_000);
    const job = await enqueue(
      s.queue as QueueName,
      s.name,
      (s.payload ?? {}) as Record<string, unknown>,
      { jobId: `sched:${s.key}:${slot}` },
    ).catch(() => null);
    if (job) fired++;
    const next = s.cron ? nextCronRun(s.cron) : new Date(Date.now() + (s.everyMs ?? 60_000));
    await prisma.jobSchedule.update({ where: { key: s.key }, data: { nextRunAt: next, lastRunAt: new Date() } });
  }
  return fired;
}

// ── Admin / health ────────────────────────────────────────────────────────

export type QueueCounts = { waiting: number; active: number; delayed: number; failed: number; completed: number };

/** Per-queue counts for the platform command center. One grouped query, not six. */
export async function queueCounts(): Promise<Record<QueueName, QueueCounts>> {
  const rows = await prisma.$queryRaw<{ queue: string; status: string; delayed: boolean; n: bigint }[]>`
    SELECT "queue", "status"::text AS status, ("status" = 'PENDING' AND "runAt" > now()) AS delayed, count(*) AS n
      FROM "jobs"
     GROUP BY "queue", "status", ("status" = 'PENDING' AND "runAt" > now())
  `;
  const out = Object.fromEntries(
    QUEUE_NAMES.map((q) => [q, { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 }]),
  ) as Record<QueueName, QueueCounts>;
  for (const r of rows) {
    const bucket = out[r.queue as QueueName];
    if (!bucket) continue;
    const n = Number(r.n);
    if (r.status === 'PENDING') {
      if (r.delayed) bucket.delayed += n;
      else bucket.waiting += n;
    } else if (r.status === 'ACTIVE') bucket.active += n;
    else if (r.status === 'FAILED') bucket.failed += n;
    else if (r.status === 'COMPLETED') bucket.completed += n;
  }
  return out;
}

export async function failedJobs(limit = 30) {
  const rows = await prisma.job.findMany({
    where: { status: 'FAILED' },
    orderBy: { finishedAt: 'desc' },
    take: limit,
    select: { id: true, queue: true, name: true, attempts: true, lastError: true, finishedAt: true },
  });
  return rows.map((j) => ({
    queue: j.queue as QueueName,
    id: j.id,
    name: j.name,
    attempts: j.attempts,
    reason: (j.lastError ?? '').slice(0, 300),
    at: j.finishedAt ? j.finishedAt.toISOString() : null,
  }));
}

/** Requeues one failed job. Returns false when it is not failed (or does not exist). */
export async function retryJob(queue: QueueName, id: string): Promise<boolean> {
  const res = await prisma.job.updateMany({
    where: { id, queue, status: 'FAILED' },
    data: { status: 'PENDING', runAt: new Date(), attempts: 0, lockedAt: null, lockedBy: null, finishedAt: null },
  });
  return res.count > 0;
}

export async function retryQueue(queue: QueueName, limit = 199): Promise<number> {
  const ids = await prisma.job.findMany({ where: { queue, status: 'FAILED' }, select: { id: true }, take: limit });
  if (!ids.length) return 0;
  const res = await prisma.job.updateMany({
    where: { id: { in: ids.map((i) => i.id) } },
    data: { status: 'PENDING', runAt: new Date(), attempts: 0, lockedAt: null, lockedBy: null, finishedAt: null },
  });
  return res.count;
}

// ── Heartbeat ─────────────────────────────────────────────────────────────

export async function recordHeartbeat(name: string, meta: Record<string, unknown> = {}) {
  await prisma.serviceHeartbeat.upsert({
    where: { name },
    create: { name, seenAt: new Date(), meta: meta as Prisma.InputJsonValue },
    update: { seenAt: new Date(), meta: meta as Prisma.InputJsonValue },
  });
}

export async function lastHeartbeat(name: string): Promise<Date | null> {
  const row = await prisma.serviceHeartbeat.findUnique({ where: { name }, select: { seenAt: true } });
  return row?.seenAt ?? null;
}
