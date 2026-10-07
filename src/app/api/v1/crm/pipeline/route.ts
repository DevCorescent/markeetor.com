import { z } from 'zod';
import { route } from '@/server/api';
import { can } from '@/server/auth/context';
import { withTenant } from '@/server/db';
import { AppError } from '@/server/errors';
import { orgSettings } from '@/server/services/organizations';

/** Board data: stages with up to `perStage` most recently moved deals each, plus totals. */
export const GET = route(
  { scope: 'ORGANIZATION', perm: ['crm.leads.read_all', 'crm.leads.read_own'], query: z.object({ perStage: z.coerce.number().int().min(10).max(100).default(50), ownerId: z.string().max(64).optional() }) },
  async ({ ctx, query }) => {
    if (!orgSettings(ctx.org?.settings).features.pipeline) throw new AppError('FORBIDDEN', 'Pipeline is not enabled for this workspace');
    const org = ctx.orgId!;
    const own = can(ctx, 'crm.leads.read_all') ? (query.ownerId ?? null) : ctx.user.id;
    return withTenant(org, async (tx) => {
      const stages = await tx.pipelineStage.findMany({ where: { organizationId: org, pipeline: { isDefault: true } }, orderBy: { position: 'asc' } });
      const base = { organizationId: org, revokedAt: null, archivedAt: null, ...(own ? { ownerId: own } : {}) };
      const totals = await tx.clientLead.groupBy({ by: ['stageId'], where: base, _count: true, _sum: { dealValue: true } });
      const columns = await Promise.all(
        stages.map(async (s) => ({
          ...s,
          count: totals.find((t) => t.stageId === s.id)?._count ?? 0,
          value: Number(totals.find((t) => t.stageId === s.id)?._sum.dealValue ?? 0),
          leads: (
            await tx.clientLead.findMany({
              where: { ...base, stageId: s.id }, orderBy: { stageEnteredAt: 'desc' }, take: query.perStage,
              select: { id: true, fullName: true, company: true, dealValue: true, currency: true, priority: true, stageEnteredAt: true, expectedCloseDate: true, probability: true, owner: { select: { name: true } } },
            })
          ).map((l) => ({ ...l, dealValue: l.dealValue ? Number(l.dealValue) : null })),
        })),
      );
      return { stages: columns };
    });
  },
);
