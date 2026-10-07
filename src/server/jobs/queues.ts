import { Queue, type JobsOptions } from 'bullmq';
import IORedis from 'ioredis';

export const QUEUE_NAMES = ['imports', 'distribution', 'automation', 'maintenance', 'email', 'enrichment'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

const g = globalThis as unknown as { __queues?: Map<string, Queue>; __bullConn?: IORedis };

export function bullConnection() {
  if (!g.__bullConn) {
    g.__bullConn = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379/0', { maxRetriesPerRequest: null });
    g.__bullConn.on('error', () => {});
  }
  return g.__bullConn;
}

export function queue(name: QueueName): Queue {
  g.__queues ??= new Map();
  let q = g.__queues.get(name);
  if (!q) {
    q = new Queue(name, {
      connection: bullConnection(),
      prefix: process.env.QUEUE_PREFIX ?? 'lcrm',
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { count: 2_000 },
        removeOnFail: { count: 5_000 },
      },
    });
    g.__queues.set(name, q);
  }
  return q;
}

/** Durable enqueue. Pass a deterministic `jobId` to make enqueueing idempotent. */
export async function enqueue(name: QueueName, jobName: string, data: Record<string, unknown>, opts: JobsOptions = {}) {
  if (process.env.NODE_ENV === 'test' && process.env.INLINE_JOBS === '1') return null;
  return queue(name).add(jobName, data, opts);
}
