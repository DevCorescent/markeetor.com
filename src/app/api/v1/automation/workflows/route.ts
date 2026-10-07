import { route } from '@/server/api';
import { withPlatform } from '@/server/db';
import { ACTION_TYPES, CONDITION_FIELDS, graphOf, TRIGGERS, upsertWorkflow, workflowInput } from '@/server/services/automation';

export const GET = route({ perm: 'automation.manage' }, async () =>
  withPlatform(async (tx) => {
    const [workflows, stats, last, orgs, templates] = await Promise.all([
      tx.workflowDefinition.findMany({ orderBy: { createdAt: 'asc' } }),
      tx.workflowExecution.groupBy({ by: ['workflowId', 'status'], _count: true }),
      tx.workflowExecution.groupBy({ by: ['workflowId'], _max: { createdAt: true } }),
      tx.organization.findMany({ where: { status: { not: 'ARCHIVED' } }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      tx.emailTemplate.findMany({ where: { organizationId: null, archivedAt: null }, select: { id: true, name: true, subject: true }, orderBy: { updatedAt: 'desc' } }),
    ]);
    return {
      triggers: TRIGGERS,
      actions: ACTION_TYPES,
      conditionFields: CONDITION_FIELDS,
      organizations: orgs,
      templates,
      workflows: workflows.map((w) => ({
        ...w,
        graph: graphOf(w),
        lastRunAt: last.find((l) => l.workflowId === w.id)?._max.createdAt ?? null,
        stats: Object.fromEntries(stats.filter((s) => s.workflowId === w.id).map((s) => [s.status, s._count])),
      })),
    };
  }),
);
export const POST = route({ perm: 'automation.manage', body: workflowInput }, async ({ ctx, body }) => upsertWorkflow(ctx, null, body));
