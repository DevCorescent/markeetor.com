import { readFileSync } from 'node:fs';

/** Loads .env, then points the app at the dedicated test database and Redis DB 15. */
export function loadTestEnv() {
  try {
    for (const line of readFileSync('.env', 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch {}
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required to run tests');
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.REDIS_URL = 'redis://localhost:6379/15';
  process.env.INLINE_JOBS = '1';
  process.env.APP_URL = 'http://localhost:3100';
  process.env.STORAGE_DIR = './storage-test';
  process.env.LOG_LEVEL = 'error';
  process.env.ENRICH_GUESS_DOMAINS = '0'; // no live DNS/website guessing in tests
  process.env.ENRICH_WEB_RESEARCH = '0';
  process.env.ENRICH_WIKIDATA = '0';
  (process.env as Record<string, string>).NODE_ENV = 'test';
}
