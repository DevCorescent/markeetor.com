import { z } from 'zod';
import { audit } from '../audit';
import type { AuthContext } from '../auth/context';
import { prisma, withPlatform } from '../db';
import { AppError, notFound } from '../errors';
import { logger } from '../logger';
import { sendEmail } from '../mail';
import { REPORT_DIMENSIONS, REPORT_METRICS, reportDefinition, runReport } from './analytics';
import { productName } from '../branding';

export const savedReportInput = z.object({
  name: z.string().trim().min(2).max(120),
  definition: reportDefinition,
  schedule: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']).nullable(),
  recipients: z.array(z.string().trim().toLowerCase().email()).max(20).default([]),
});

/** Saved reports belong to their owner and scope (platform or one workspace). */
export async function listSavedReports(ctx: AuthContext) {
  return prisma.savedReport.findMany({ where: { organizationId: ctx.orgId, ownerId: ctx.user.id }, orderBy: { updatedAt: 'desc' } });
}

export async function saveReport(ctx: AuthContext, id: string | null, input: z.infer<typeof savedReportInput>) {
  // Scheduled delivery can only target members of the same scope, never arbitrary addresses.
  if (input.recipients.length) {
    const allowed = await prisma.user.findMany({ where: { email: { in: input.recipients }, status: 'ACTIVE', membership: { is: { organizationId: ctx.orgId } } }, select: { email: true } });
    const ok = new Set(allowed.map((u) => u.email));
    const bad = input.recipients.filter((r) => !ok.has(r));
    if (bad.length) throw new AppError('VALIDATION_FAILED', `Recipients must be active users in your ${ctx.orgId ? 'workspace' : 'platform team'}: ${bad.join(', ')}`);
  }
  return withPlatform(async (tx) => {
    if (id) {
      const existing = await tx.savedReport.findUnique({ where: { id } });
      if (!existing || existing.ownerId !== ctx.user.id || existing.organizationId !== ctx.orgId) throw notFound('Report');
      const r = await tx.savedReport.update({ where: { id }, data: { ...input, definition: input.definition } });
      await audit(tx, ctx, { action: 'report.updated', targetType: 'report', targetId: id, after: input });
      return r;
    }
    const r = await tx.savedReport.create({ data: { ...input, definition: input.definition, ownerId: ctx.user.id, organizationId: ctx.orgId } });
    await audit(tx, ctx, { action: 'report.created', targetType: 'report', targetId: r.id, after: input });
    return r;
  });
}

export async function deleteReport(ctx: AuthContext, id: string) {
  const existing = await prisma.savedReport.findUnique({ where: { id } });
  if (!existing || existing.ownerId !== ctx.user.id || existing.organizationId !== ctx.orgId) throw notFound('Report');
  await prisma.savedReport.delete({ where: { id } });
}

function due(schedule: string, lastRunAt: Date | null) {
  if (!lastRunAt) return true;
  const ms = schedule === 'DAILY' ? 86400_000 : schedule === 'WEEKLY' ? 7 * 86400_000 : 28 * 86400_000;
  return Date.now() - lastRunAt.getTime() >= ms - 3600_000;
}

/** Worker: emails due scheduled reports (aggregates only — never lead-level records). */
export async function runScheduledReports() {
  const reports = await prisma.savedReport.findMany({ where: { schedule: { not: null } } });
  let sent = 0;
  for (const r of reports) {
    if (!due(r.schedule!, r.lastRunAt) || !r.recipients.length) continue;
    try {
      const def = reportDefinition.parse(r.definition);
      const rows = await runReport(def, r.organizationId ?? undefined);
      const body = [
        `${r.name}`,
        `${REPORT_METRICS[def.metric]} by ${REPORT_DIMENSIONS[def.groupBy].toLowerCase()} — last ${def.rangeDays} days`,
        '',
        ...rows.slice(0, 100).map((x) => `${x.label.padEnd(36)} ${x.value}`),
        '',
        `Aggregated figures only. Open ${await productName()} for details.`,
      ].join('\n');
      for (const to of r.recipients) await sendEmail({ to, subject: `[Report] ${r.name}`, body });
      await prisma.savedReport.update({ where: { id: r.id }, data: { lastRunAt: new Date() } });
      sent++;
    } catch (err) {
      logger.error({ err, reportId: r.id }, 'scheduled report failed');
    }
  }
  return { sent };
}
