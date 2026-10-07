import { logger } from './logger';
import { redis } from './redis';

export type RateResult = { ok: boolean; remaining: number; resetSec: number; count: number };

/** Fixed-window counter in Redis. Fails open (with a log line) if Redis is unavailable. */
export async function rateLimit(key: string, limit: number, windowSec: number): Promise<RateResult> {
  const bucket = Math.floor(Date.now() / 1000 / windowSec);
  const k = `rl:${key}:${bucket}`;
  try {
    const r = redis();
    const res = await r.multi().incr(k).expire(k, windowSec + 1).exec();
    const count = Number(res?.[0]?.[1] ?? 0);
    const resetSec = windowSec - (Math.floor(Date.now() / 1000) % windowSec);
    return { ok: count <= limit, remaining: Math.max(0, limit - count), resetSec, count };
  } catch (err) {
    logger.warn({ err, key }, 'rate limiter unavailable; failing open');
    return { ok: true, remaining: limit, resetSec: windowSec, count: 0 };
  }
}

/** Increments a counter without enforcing, returning the current count in the window. */
export async function bumpCounter(key: string, windowSec: number): Promise<number> {
  const r = await rateLimit(key, Number.MAX_SAFE_INTEGER, windowSec);
  return r.count;
}
