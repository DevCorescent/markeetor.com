import { beforeAll, describe, expect, it } from 'vitest';
import { withPlatform } from '@/server/db';
import { createDistribution, executeBatch, previewDistribution, revokeLeads, selectionInsight } from '@/server/services/distribution';
import { distributionAnalytics, distributionTracker, domainOf } from '@/server/services/distribution-insights';
import { listLeads } from '@/server/services/leads';
import { ctxFor, ensureRoles, makeLeads, makeOrg, makeUser } from '../helpers';

let owner: { id: string };
beforeAll(async () => {
  await ensureRoles();
  owner = await makeUser('platform_owner', null);
});

const distribute = async (ids: string[], orgIds: string[], extra: { avoidPreviousClients?: boolean } = {}) => {
  const { batch } = await createDistribution(await ctxFor(owner.id), {
    selection: { mode: 'ids', ids }, strategy: 'EQUAL', targets: orgIds.map((organizationId) => ({ organizationId })),
    respectQuotas: true, includeInvalid: false, idempotencyKey: `t-${Math.random()}`, confirmLarge: true, ...extra,
  });
  await executeBatch(batch.id);
  return batch;
};

describe('distribution tracking', () => {
  it('counts every allocation and never resends a lead to a client that already had it', async () => {
    const a = await makeOrg();
    const b = await makeOrg();
    await withPlatform((tx) => tx.organization.update({ where: { id: a.id }, data: { website: 'https://www.alpha-realty.test/about', industry: 'Real Estate' } }));
    const [lead] = await makeLeads(1);

    await distribute([lead], [a.id]);
    let row = await withPlatform((tx) => tx.lead.findUniqueOrThrow({ where: { id: lead } }));
    expect(row.distributionCount).toBe(1);
    expect(row.lastDistributedAt).not.toBeNull();

    await revokeLeads(await ctxFor(owner.id), { mode: 'ids', ids: [lead] }, 'Client returned it');

    // Only the previous client selected: it is not sent back.
    const onlyA = await previewDistribution({ selection: { mode: 'ids', ids: [lead] }, strategy: 'EQUAL', targets: [{ organizationId: a.id }], respectQuotas: true, includeInvalid: false });
    expect(onlyA.planned).toBe(0);
    expect(onlyA.unassigned).toEqual({ 'Every selected client already had this lead': 1 });
    // …unless explicitly allowed.
    const allowed = await previewDistribution({ selection: { mode: 'ids', ids: [lead] }, strategy: 'EQUAL', targets: [{ organizationId: a.id }], respectQuotas: true, includeInvalid: false, avoidPreviousClients: false });
    expect(allowed.planned).toBe(1);

    // Insight explains it before the user even picks a split.
    const insight = await selectionInsight({ selection: { mode: 'ids', ids: [lead] }, includeInvalid: false });
    expect(insight.previouslyDistributed).toBe(1);
    expect(insight.clients.find((c) => c.organizationId === a.id)?.hadBefore).toBe(1);
    expect(insight.clients.find((c) => c.organizationId === b.id)?.hadBefore).toBe(0);

    // Offered to both clients, it goes to the new one.
    const preview = await previewDistribution({ selection: { mode: 'ids', ids: [lead] }, strategy: 'EQUAL', targets: [{ organizationId: a.id }, { organizationId: b.id }], respectQuotas: true, includeInvalid: false });
    expect(preview.redistributed).toBe(1);
    expect(preview.targets.find((t) => t.organizationId === b.id)?.sample.map((s) => s.id)).toEqual([lead]);
    await distribute([lead], [a.id, b.id]);
    row = await withPlatform((tx) => tx.lead.findUniqueOrThrow({ where: { id: lead } }));
    expect(row.distributionCount).toBe(2);
    expect(row.assignedOrganizationId).toBe(b.id);

    // Tracker: full journey in order, with the client's web domain.
    const tracked = await distributionTracker({ filter: { conditions: [{ field: 'everClient', op: 'in', value: [a.id] }] }, page: 1, pageSize: 10 });
    const t = tracked.rows.find((r) => r.id === lead)!;
    expect(t.distributionCount).toBe(2);
    expect(t.clients).toBe(2);
    expect(t.assignments.map((x) => [x.organization.id, x.status])).toEqual([[a.id, 'REVOKED'], [b.id, 'ACTIVE']]);
    expect(t.assignments[0].organization.domain).toBe('alpha-realty.test');

    // Analytics: redistribution and returns are attributed to the right clients.
    const an = await distributionAnalytics({ days: 1, organizationId: b.id });
    expect(an.kpis.assignments).toBeGreaterThanOrEqual(1);
    expect(an.kpis.redistributed).toBeGreaterThanOrEqual(1);
    expect(an.clients.find((c) => c.id === b.id)?.redistributed).toBe(1);
    const anA = await distributionAnalytics({ days: 1, organizationId: a.id });
    expect(anA.clients.find((c) => c.id === a.id)?.returned).toBe(1);
    expect(anA.clients.find((c) => c.id === a.id)?.domain).toBe('alpha-realty.test');
    const byDomain = await distributionAnalytics({ days: 1, industry: 'Real Estate' });
    expect(byDomain.clients.every((c) => c.industry === 'Real Estate')).toBe(true);
  });

  it('filters leads by how many times and to whom they were distributed', async () => {
    const org = await makeOrg();
    const [sent, fresh] = await makeLeads(2);
    await distribute([sent], [org.id]);
    const ids = [sent, fresh];
    const q = async (conditions: { field: string; op: string; value: unknown }[]) =>
      (await listLeads({ filter: { conditions: [...conditions, { field: 'fullName', op: 'contains', value: 'Lead' }] as never }, view: 'all', page: 1, pageSize: 200 })).rows.map((r) => r.id).filter((id) => ids.includes(id));
    expect(await q([{ field: 'distributionCount', op: 'eq', value: 0 }])).toEqual([fresh]);
    expect(await q([{ field: 'distributionCount', op: 'gte', value: 1 }])).toEqual([sent]);
    expect(await q([{ field: 'everClient', op: 'in', value: [org.id] }])).toEqual([sent]);
    expect((await q([{ field: 'everClient', op: 'not_in', value: [org.id] }])).sort()).toEqual([fresh]);
  });

  it('extracts client domains from websites', () => {
    expect(domainOf('https://www.Acme.com/about')).toBe('acme.com');
    expect(domainOf('acme.io')).toBe('acme.io');
    expect(domainOf('')).toBeNull();
    expect(domainOf('not a url ::')).toBeNull();
  });
});
