import { prisma, withPlatform } from '../db';
import { logger } from '../logger';
import { redis } from '../redis';
import { getSetting } from '../settings';

/** Runs every minute from the worker. Cheap housekeeping plus once-a-day retention work. */
export async function runMaintenance() {
  const now = new Date();
  const sessions = await prisma.session.deleteMany({
    where: { OR: [{ expiresAt: { lt: new Date(now.getTime() - 90 * 86400_000) } }, { revokedAt: { lt: new Date(now.getTime() - 90 * 86400_000) } }] },
  });
  await prisma.approvalRequest.updateMany({ where: { status: 'PENDING', expiresAt: { lt: now } }, data: { status: 'EXPIRED' } });
  await prisma.passwordResetToken.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 7 * 86400_000) } } });

  // Once per day: audit retention.
  const day = now.toISOString().slice(0, 10);
  const claimed = await redis().set(`maintenance:audit-retention:${day}`, '1', 'EX', 2 * 86400, 'NX');
  let purged = 0;
  if (claimed) purged = await purgeAuditEvents();
  if (sessions.count || purged) logger.info({ sessionsDeleted: sessions.count, auditPurged: purged }, 'maintenance');
  return { sessionsDeleted: sessions.count, auditPurged: purged };
}

/**
 * Deletes audit events older than the configured retention period. This is the ONLY code path allowed
 * to delete audit rows (it opts in via app.audit_purge inside its own transaction) and it records itself.
 */
export async function purgeAuditEvents() {
  const { days } = await getSetting('audit.retention');
  if (!days || days < 30) return 0; // guard against misconfiguration
  const cutoff = new Date(Date.now() - days * 86400_000);
  return withPlatform(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.audit_purge', 'on', true)`;
    const n = await tx.$executeRaw`DELETE FROM audit_events WHERE "createdAt" < ${cutoff}`;
    await tx.$executeRaw`SELECT set_config('app.audit_purge', 'off', true)`;
    if (n > 0) {
      await tx.auditEvent.create({ data: { action: 'audit.retention.purged', result: 'SUCCESS', metadata: { deleted: n, cutoff: cutoff.toISOString(), retentionDays: days } } });
    }
    return n;
  }, { timeout: 300_000 });
}
