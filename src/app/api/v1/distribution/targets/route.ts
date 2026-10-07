import { route } from '@/server/api';
import { withPlatform } from '@/server/db';
import { targetStatuses } from '@/server/services/distribution';
import { domainOf } from '@/server/services/distribution-insights';

/** Every non-archived client with live quota headroom — the pick-list for manual distribution. */
export const GET = route({ perm: ['distribution.create', 'distribution.rules'] }, async () =>
  withPlatform(async (tx) => {
    const orgs = await tx.organization.findMany({ where: { status: { not: 'ARCHIVED' } }, orderBy: { name: 'asc' }, select: { id: true, code: true, industry: true, website: true } });
    const statuses = await targetStatuses(tx, orgs.map((o) => ({ organizationId: o.id })), { respectQuotas: true });
    const totals = await tx.leadAssignment.groupBy({ by: ['organizationId'], where: { organizationId: { in: orgs.map((o) => o.id) } }, _count: true, _max: { assignedAt: true } });
    return {
      targets: statuses.map((s) => {
        const o = orgs.find((x) => x.id === s.organizationId);
        const t = totals.find((x) => x.organizationId === s.organizationId);
        return { ...s, capacity: Number.isFinite(s.capacity) ? s.capacity : null, code: o?.code ?? null, industry: o?.industry ?? null, domain: domainOf(o?.website), lifetime: t?._count ?? 0, lastReceived: t?._max.assignedAt ?? null };
      }),
    };
  }),
);
