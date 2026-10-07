import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, withPlatform, withTenant } from '@/server/db';
import { createDistribution, executeBatch, reassignLeads, rollbackBatch } from '@/server/services/distribution';
import { ctxFor, ensureRoles, makeLeads, makeOrg, makeUser } from '../helpers';

let owner: { id: string };
beforeAll(async () => {
  await ensureRoles();
  owner = await makeUser('platform_owner', null);
});

const base = { strategy: 'EQUAL' as const, respectQuotas: true, includeInvalid: false, confirmLarge: true };

describe('distribution consistency', () => {
  it('is idempotent on the idempotency key', async () => {
    const ctx = await ctxFor(owner.id);
    const org = await makeOrg();
    const ids = await makeLeads(5);
    const a = await createDistribution(ctx, { ...base, selection: { mode: 'ids', ids }, targets: [{ organizationId: org.id }], idempotencyKey: 'idem-test-0001' });
    const b = await createDistribution(ctx, { ...base, selection: { mode: 'ids', ids }, targets: [{ organizationId: org.id }], idempotencyKey: 'idem-test-0001' });
    expect(b.duplicate).toBe(true);
    expect(b.batch.id).toBe(a.batch.id);
    expect(await withPlatform((tx) => tx.assignmentBatch.count({ where: { idempotencyKey: 'idem-test-0001' } }))).toBe(1);
  });

  it('never allocates a lead twice under concurrent batches', async () => {
    const ctx = await ctxFor(owner.id);
    const [o1, o2] = [await makeOrg(), await makeOrg()];
    const ids = await makeLeads(40);
    const runs = await Promise.allSettled([
      createDistribution(ctx, { ...base, selection: { mode: 'ids', ids }, targets: [{ organizationId: o1.id }], idempotencyKey: 'race-0001-aaaa' }),
      createDistribution(ctx, { ...base, selection: { mode: 'ids', ids }, targets: [{ organizationId: o2.id }], idempotencyKey: 'race-0002-bbbb' }),
    ]);
    const batches = runs.filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof createDistribution>>>).value.batch);
    await Promise.allSettled(batches.map((b) => executeBatch(b.id)));
    const active = await withPlatform((tx) => tx.leadAssignment.groupBy({ by: ['leadId'], where: { leadId: { in: ids }, status: 'ACTIVE' }, _count: true }));
    expect(active.every((a) => a._count === 1)).toBe(true);
    expect(active.length).toBe(40);
    const leads = await withPlatform((tx) => tx.lead.findMany({ where: { id: { in: ids } }, select: { allocationStatus: true } }));
    expect(leads.every((l) => l.allocationStatus === 'ALLOCATED')).toBe(true);
  });

  it('the database forbids two active assignments for one lead', async () => {
    const o1 = await makeOrg();
    const o2 = await makeOrg();
    const [id] = await makeLeads(1);
    await withPlatform((tx) => tx.leadAssignment.create({ data: { leadId: id, organizationId: o1.id, assignedById: owner.id } }));
    await expect(withPlatform((tx) => tx.leadAssignment.create({ data: { leadId: id, organizationId: o2.id, assignedById: owner.id } }))).rejects.toThrow();
  });

  it('respects quotas at execution time and auto-pauses at capacity', async () => {
    const ctx = await ctxFor(owner.id);
    const org = await makeOrg('Small', { maxActiveLeads: 50, dailyAllocationLimit: 100 });
    const ids = await makeLeads(10);
    const { batch } = await createDistribution(ctx, { ...base, selection: { mode: 'ids', ids }, targets: [{ organizationId: org.id }], idempotencyKey: 'quota-0001-cccc' });
    // Quota shrinks between planning and execution: the worker must re-check live headroom.
    await prisma.clientQuota.update({ where: { organizationId: org.id }, data: { maxActiveLeads: 3 } });
    const done = await executeBatch(batch.id);
    expect(done?.allocatedCount).toBe(3);
    expect(done?.failedCount).toBe(7);
    expect(done?.status).toBe('PARTIAL');
    const q = await prisma.clientQuota.findUniqueOrThrow({ where: { organizationId: org.id } });
    expect(q.capacityPaused).toBe(true);
    const released = await withPlatform((tx) => tx.lead.count({ where: { id: { in: ids }, allocationStatus: 'UNALLOCATED' } }));
    expect(released).toBe(7);
  });

  it('excludes suspended clients during planning', async () => {
    const ctx = await ctxFor(owner.id);
    const ok = await makeOrg();
    const bad = await makeOrg();
    await prisma.organization.update({ where: { id: bad.id }, data: { status: 'SUSPENDED' } });
    const ids = await makeLeads(4);
    const { batch } = await createDistribution(ctx, { ...base, selection: { mode: 'ids', ids }, targets: [{ organizationId: ok.id }, { organizationId: bad.id }], idempotencyKey: 'susp-0001-dddd' });
    await executeBatch(batch.id);
    expect(await withPlatform((tx) => tx.leadAssignment.count({ where: { organizationId: bad.id } }))).toBe(0);
    expect(await withPlatform((tx) => tx.leadAssignment.count({ where: { organizationId: ok.id } }))).toBe(4);
  });

  it('rollback revokes untouched allocations but keeps worked ones', async () => {
    const ctx = await ctxFor(owner.id);
    const org = await makeOrg();
    const ids = await makeLeads(4);
    const { batch } = await createDistribution(ctx, { ...base, selection: { mode: 'ids', ids }, targets: [{ organizationId: org.id }], idempotencyKey: 'rb-0001-eeee' });
    await executeBatch(batch.id);
    const worked = await withTenant(org.id, (tx) => tx.clientLead.findFirstOrThrow({ where: { organizationId: org.id } }));
    await withTenant(org.id, (tx) => tx.clientLead.update({ where: { id: worked.id }, data: { status: 'CONTACTED', firstContactAt: new Date() } }));
    const res = await rollbackBatch(ctx, batch.id, 'wrong client', false);
    expect(res).toEqual({ revoked: 3, keptWorked: 1 });
    const visible = await withTenant(org.id, (tx) => tx.clientLead.count({ where: { organizationId: org.id, revokedAt: null } }));
    expect(visible).toBe(1);
    expect(await withPlatform((tx) => tx.lead.count({ where: { id: { in: ids }, allocationStatus: 'UNALLOCATED' } }))).toBe(3);
  });

  it('reassignment hides the old tenant’s projection and never shows it to the new tenant', async () => {
    const ctx = await ctxFor(owner.id);
    const [from, to] = [await makeOrg(), await makeOrg()];
    const ids = await makeLeads(2);
    const { batch } = await createDistribution(ctx, { ...base, selection: { mode: 'ids', ids }, targets: [{ organizationId: from.id }], idempotencyKey: 'rsg-0001-ffff' });
    await executeBatch(batch.id);
    const old = await withTenant(from.id, (tx) => tx.clientLead.findFirstOrThrow({ where: { organizationId: from.id } }));
    await withTenant(from.id, (tx) => tx.note.create({ data: { organizationId: from.id, clientLeadId: old.id, authorId: owner.id, body: 'confidential' } }));
    const r = await reassignLeads(ctx, { mode: 'ids', ids }, to.id, 'rebalancing', 'rsg-0002-gggg', true);
    await executeBatch(r.batch.id);
    expect(await withTenant(from.id, (tx) => tx.clientLead.count({ where: { revokedAt: null } }))).toBe(0);
    const fresh = await withTenant(to.id, (tx) => tx.clientLead.findMany({ include: { notes: true } }));
    expect(fresh).toHaveLength(2);
    expect(fresh.flatMap((f) => f.notes)).toHaveLength(0);
  });
});
