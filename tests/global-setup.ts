import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import IORedis from 'ioredis';
import { loadTestEnv } from './load-env';

/**
 * Rebuilds the dedicated TEST database from migrations before the suite runs. Refuses to touch any
 * database whose name does not end in "_test", so it can never reset development or production data.
 */
export default async function setup() {
  loadTestEnv();
  const url = new URL(process.env.DATABASE_URL!);
  const dbName = url.pathname.replace(/^\//, '');
  if (!dbName.endsWith('_test')) throw new Error(`Refusing to reset non-test database "${dbName}"`);
  const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
  await prisma.$executeRawUnsafe('CREATE SCHEMA public');
  await prisma.$disconnect();
  execSync('npx prisma migrate deploy', { env: process.env, stdio: 'pipe' });
  const redis = new IORedis(process.env.REDIS_URL!);
  await redis.flushdb();
  await redis.quit();
  rmSync('./storage-test', { recursive: true, force: true });
}
