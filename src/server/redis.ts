import IORedis, { type Redis } from 'ioredis';

const g = globalThis as unknown as { __redis?: Redis };

export function redis(): Redis {
  if (!g.__redis) {
    g.__redis = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379/0', {
      maxRetriesPerRequest: null,
      enableOfflineQueue: true,
      lazyConnect: false,
    });
    g.__redis.on('error', () => {
      /* surfaced through health checks; avoid crashing the process */
    });
  }
  return g.__redis;
}
