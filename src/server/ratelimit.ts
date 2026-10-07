import { Prisma } from '@prisma/client';
import { prisma } from './db';
import { logger } from './logger';

export type RateResult = { ok: boolean; remaining: number; resetSec: number; count: number };

/**
 * Fixed-window counter in Postgres. Fails open (with a log line) if the database is
 * unavailable — and unlike the former Redis implementation it genuinely does: Prisma
 * surfaces connection errors as exceptions, where ioredis (configured with
 * `maxRetriesPerRequest: null`) queued commands forever and hung the request instead.
 *
 * The window bucket is part of the key, so each window is its own row and expiry is
 * only needed to reclaim space (see `pruneRateLimits`). The increment is a single
 * atomic upsert, so concurrent requests cannot both read a stale count.
 *
 * These counters are deliberately durable rather than in-process: several windows run
 * for an hour and gate security controls (login brute force, password reset, MFA) and
 * paid lead reveals, so a restart must not reset them, and limits must hold across
 * however many app instances are running.
 */
export async function rateLimit(key: string, limit: number, windowSec: number): Promise<RateResult> {
  const bucket = Math.floor(Date.now() / 1000 / windowSec);
  const k = `rl:${key}:${bucket}`;
  const resetSec = windowSec - (Math.floor(Date.now() / 1000) % windowSec);
  // Keep rows a little past the window so a clock skew between app instances cannot
  // delete a counter that is still in force.
  const expiresAt = new Date((bucket + 1) * windowSec * 1000 + 60_000);
  try {
    const rows = await prisma.$queryRaw<{ count: number }[]>`
      INSERT INTO "rate_limit_counters" ("key", "count", "expiresAt")
      VALUES (${k}, 1, ${expiresAt})
      ON CONFLICT ("key") DO UPDATE SET "count" = "rate_limit_counters"."count" + 1
      RETURNING "count"
    `;
    const count = Number(rows[0]?.count ?? 0);
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

/** Drops expired counters. Called from the maintenance job. */
export async function pruneRateLimits(): Promise<number> {
  try {
    const res: number = await prisma.$executeRaw(
      Prisma.sql`DELETE FROM "rate_limit_counters" WHERE "expiresAt" <= now()`,
    );
    return res;
  } catch (err) {
    logger.warn({ err }, 'could not prune rate limit counters');
    return 0;
  }
}
