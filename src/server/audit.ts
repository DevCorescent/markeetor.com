import type { AuditResult, Prisma } from '@prisma/client';
import type { AuthContext } from './auth/context';
import { withPlatform, type Db } from './db';
import { logger } from './logger';

export type AuditInput = {
  action: string;
  targetType?: string;
  targetId?: string | null;
  organizationId?: string | null;
  result?: AuditResult;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
};

type Actor = Partial<Pick<AuthContext, 'user' | 'role' | 'orgId' | 'requestId' | 'ip' | 'userAgent' | 'session'>> | null;

const SECRET_KEY = /pass(word)?|secret|token|hash|recovery|apikey|api_key|mfa/i;

/** Removes secret-like keys and truncates large values before they reach the audit log. */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (depth > 4) return '[truncated]';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'object' && 'toString' in (value as object)) return String(value);
  return value;
}

/** Shallow diff of changed keys, so audit rows only carry what actually changed. */
export function diff<T extends Record<string, unknown>>(before: T, after: Partial<T>) {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const k of Object.keys(after)) {
    const bv = before[k];
    const av = after[k];
    const same = JSON.stringify(redact(bv)) === JSON.stringify(redact(av));
    if (!same && av !== undefined) {
      b[k] = bv;
      a[k] = av;
    }
  }
  return { before: b, after: a, changed: Object.keys(a) };
}

function data(actor: Actor, input: AuditInput): Prisma.AuditEventCreateInput {
  return {
    action: input.action,
    actorId: actor?.user?.id ?? null,
    actorEmail: actor?.user?.email ?? null,
    actorRole: actor?.role?.key ?? null,
    organizationId: input.organizationId !== undefined ? input.organizationId : (actor?.orgId ?? null),
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    result: input.result ?? 'SUCCESS',
    reason: input.reason ?? null,
    before: input.before === undefined ? undefined : (redact(input.before) as Prisma.InputJsonValue),
    after: input.after === undefined ? undefined : (redact(input.after) as Prisma.InputJsonValue),
    metadata: input.metadata ? (redact(input.metadata) as Prisma.InputJsonValue) : undefined,
    requestId: actor?.requestId ?? null,
    sessionId: actor?.session?.id ?? null,
    ip: actor?.ip ?? null,
    userAgent: actor?.userAgent?.slice(0, 300) ?? null,
  };
}

/** Writes an audit event inside the caller's transaction, so it commits or rolls back with the change. */
export async function audit(db: Db, actor: Actor, input: AuditInput) {
  await db.auditEvent.create({ data: data(actor, input) });
}

/** Writes an audit event in its own platform transaction (for denials, logins, failures). Never throws. */
export async function auditDetached(actor: Actor, input: AuditInput) {
  try {
    await withPlatform((tx) => tx.auditEvent.create({ data: data(actor, input) }));
  } catch (err) {
    logger.error({ err, action: input.action }, 'failed to write audit event');
  }
}
