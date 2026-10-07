import { hash, verify } from '@node-rs/argon2';

// OWASP-recommended argon2id parameters (19 MiB, t=2, p=1).
const OPTS = { algorithm: 2 /* Argon2id */, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTS);
}

export async function verifyPassword(stored: string | null | undefined, password: string): Promise<boolean> {
  if (!stored) {
    // Spend comparable time so missing accounts aren't distinguishable by timing.
    await hash(password, OPTS).catch(() => null);
    return false;
  }
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}

const COMMON = new Set([
  'password', 'password1', 'password123', '123456789012', 'qwertyuiop', 'letmein', 'welcome', 'admin', 'administrator',
  'iloveyou', 'monkey', 'dragon', 'football', 'baseball', 'passw0rd', 'changeme', 'trustno1', 'superman', 'qwerty123',
]);

export function passwordProblems(password: string, minLength: number, context: string[] = []): string[] {
  const problems: string[] = [];
  if (password.length < minLength) problems.push(`Use at least ${minLength} characters`);
  if (password.length > 256) problems.push('Use at most 256 characters');
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  if (classes < 3) problems.push('Mix at least three of: lowercase, uppercase, digits, symbols');
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || COMMON.has(lower.replace(/[^a-z]/g, ''))) problems.push('This password is too common');
  for (const c of context) {
    const part = c.toLowerCase().split('@')[0];
    if (part.length >= 4 && lower.includes(part)) {
      problems.push('Password must not contain your name or email');
      break;
    }
  }
  return problems;
}
