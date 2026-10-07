import { z } from 'zod';
import { paginationQuery, route } from '@/server/api';
import { withPlatform } from '@/server/db';

export const GET = route({ perm: 'automation.manage', query: paginationQuery.extend({ workflowId: z.string().max(64).optional(), status: z.string().max(20).optional() }) }, async ({ query }) =>
  withPlatform(async (tx) => {
    const where = { ...(query.workflowId ? { workflowId: query.workflowId } : {}), ...(query.status ? { status: query.status as 'FAILED' } : {}) };
    const [total, rows] = await Promise.all([
      tx.workflowExecution.count({ where }),
      tx.workflowExecution.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize, include: { workflow: { select: { name: true } } } }),
    ]);
    // Human-readable subject names (lead or task) for the run history.
    const leadIds = rows.filter((r) => r.subjectType === 'client_lead').map((r) => r.subjectId);
    const taskIds = rows.filter((r) => r.subjectType === 'task').map((r) => r.subjectId);
    const [leads, tasks] = await Promise.all([
      leadIds.length ? tx.clientLead.findMany({ where: { id: { in: leadIds } }, select: { id: true, fullName: true, organization: { select: { name: true } } } }) : [],
      taskIds.length ? tx.task.findMany({ where: { id: { in: taskIds } }, select: { id: true, title: true, organizationId: true } }) : [],
    ]);
    const orgNames = new Map((await tx.organization.findMany({ where: { id: { in: [...new Set(tasks.map((t) => t.organizationId))] } }, select: { id: true, name: true } })).map((o) => [o.id, o.name]));
    const names = new Map<string, { name: string; organization: string }>([
      ...leads.map((l) => [l.id, { name: l.fullName, organization: l.organization.name }] as const),
      ...tasks.map((t) => [t.id, { name: t.title, organization: orgNames.get(t.organizationId) ?? '—' }] as const),
    ]);
    return { total, rows: rows.map((r) => ({ ...r, subject: names.get(r.subjectId) ?? null })) };
  }),
);
