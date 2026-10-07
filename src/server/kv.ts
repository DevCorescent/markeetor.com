/**
 * Small TTL key-value store on Postgres, replacing the non-queue Redis usage:
 * once-only claims, short-lived secrets, and period counters.
 *
 * Every operation is a single atomic statement, so concurrent app instances see the same
 * semantics they did with Redis. An expired row is treated as absent everywhere (rather
 * than relying on a sweeper having run), which is what makes `claim` safe as a lock.
 */
import { prisma } from './db';
import { logger } from './logger';

const ttlDate = (ttlSec?: number) => (ttlSec && ttlSec > 0 ? new Date(Date.now() + ttlSec * 1000) : null);

/**
 * Equivalent of `SET key value EX ttl NX`: returns true only if the caller won the key.
 * A row whose TTL has passed counts as free, so this doubles as an expiring lock.
 *
 * Throws if the database is unreachable rather than guessing: each call site decides
 * whether a storage failure should block its work (`.catch(() => false)`) or let it
 * through (`.catch(() => true)`), which is how the Redis version behaved per site.
 */
export async function claim(key: string, ttlSec: number, value = '1'): Promise<boolean> {
  const expiresAt = ttlDate(ttlSec);
  const rows = await prisma.$queryRaw<{ key: string }[]>`
    INSERT INTO "kv_store" ("key", "value", "expiresAt", "updatedAt")
    VALUES (${key}, ${value}, ${expiresAt}, now())
    ON CONFLICT ("key") DO UPDATE
      SET "value" = EXCLUDED."value", "expiresAt" = EXCLUDED."expiresAt", "updatedAt" = now()
      WHERE "kv_store"."expiresAt" IS NOT NULL AND "kv_store"."expiresAt" <= now()
    RETURNING "key"
  `;
  return rows.length > 0;
}

export async function set(key: string, value: string, ttlSec?: number): Promise<void> {
  const expiresAt = ttlDate(ttlSec);
  await prisma.$executeRaw`
    INSERT INTO "kv_store" ("key", "value", "expiresAt", "updatedAt")
    VALUES (${key}, ${value}, ${expiresAt}, now())
    ON CONFLICT ("key") DO UPDATE
      SET "value" = EXCLUDED."value", "expiresAt" = EXCLUDED."expiresAt", "updatedAt" = now()
  `;
}

export async function get(key: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ value: string }[]>`
    SELECT "value" FROM "kv_store"
     WHERE "key" = ${key} AND ("expiresAt" IS NULL OR "expiresAt" > now())
  `;
  return rows[0]?.value ?? null;
}

export async function del(key: string): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "kv_store" WHERE "key" = ${key}`;
}

/**
 * Atomic increment. The TTL is applied when the key is created (or revived after
 * expiry) and is not extended by later increments — matching the
 * `INCR` + `EXPIRE`-only-on-first-hit pattern this replaces.
 */
export async function incr(key: string, ttlSec?: number, by = 1): Promise<number> {
  const expiresAt = ttlDate(ttlSec);
  const rows = await prisma.$queryRaw<{ value: string }[]>`
    INSERT INTO "kv_store" ("key", "value", "expiresAt", "updatedAt")
    VALUES (${key}, ${String(by)}, ${expiresAt}, now())
    ON CONFLICT ("key") DO UPDATE
      SET "value" = ((CASE
                        WHEN "kv_store"."expiresAt" IS NOT NULL AND "kv_store"."expiresAt" <= now() THEN 0
                        ELSE "kv_store"."value"::bigint
                      END) + ${by})::text,
          "expiresAt" = CASE
                          WHEN "kv_store"."expiresAt" IS NOT NULL AND "kv_store"."expiresAt" <= now()
                            THEN EXCLUDED."expiresAt"
                          ELSE "kv_store"."expiresAt"
                        END,
          "updatedAt" = now()
    RETURNING "value"
  `;
  return Number(rows[0]?.value ?? by);
}

export function decr(key: string, by = 1): Promise<number> {
  return incr(key, undefined, -by);
}

/** Reads a counter without creating it. */
export async function getNumber(key: string): Promise<number> {
  const v = await get(key);
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Drops expired rows. Called from the maintenance job. */
export async function pruneKv(): Promise<number> {
  try {
    return await prisma.$executeRaw`DELETE FROM "kv_store" WHERE "expiresAt" IS NOT NULL AND "expiresAt" <= now()`;
  } catch (err) {
    logger.warn({ err }, 'could not prune kv store');
    return 0;
  }
}
