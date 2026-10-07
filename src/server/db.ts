import { Prisma, PrismaClient } from '@prisma/client';

const g = globalThis as unknown as { __prisma?: PrismaClient };

/**
 * Raw client. Tables protected by row-level security return no rows through it
 * unless used inside `withPlatform` / `withTenant`. Auth tables (users, sessions,
 * memberships, roles) are not RLS-protected and are accessed directly.
 */
export const prisma: PrismaClient =
  g.__prisma ?? new PrismaClient({ log: process.env.PRISMA_LOG === '1' ? ['query', 'warn', 'error'] : ['warn', 'error'] });
if (process.env.NODE_ENV !== 'production') g.__prisma = prisma;

export type Tx = Prisma.TransactionClient;
export type Db = PrismaClient | Tx;

type TxOptions = { timeout?: number; maxWait?: number; isolationLevel?: Prisma.TransactionIsolationLevel };

/** Runs `fn` in a transaction with platform (RLS bypass) visibility. Only for platform-scoped code paths. */
export function withPlatform<T>(fn: (tx: Tx) => Promise<T>, opts: TxOptions = {}): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true), set_config('app.org_id', '', true)`;
      return fn(tx);
    },
    { timeout: opts.timeout ?? 20_000, maxWait: opts.maxWait ?? 10_000, isolationLevel: opts.isolationLevel },
  );
}

/** Runs `fn` in a transaction where the database only exposes rows belonging to `organizationId`. */
export function withTenant<T>(organizationId: string, fn: (tx: Tx) => Promise<T>, opts: TxOptions = {}): Promise<T> {
  if (!organizationId) throw new Error('withTenant requires an organizationId');
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'off', true), set_config('app.org_id', ${organizationId}, true)`;
      return fn(tx);
    },
    { timeout: opts.timeout ?? 20_000, maxWait: opts.maxWait ?? 10_000, isolationLevel: opts.isolationLevel },
  );
}
