import { beforeAll, describe, expect, it } from 'vitest';
import { withPlatform } from '@/server/db';
import { configureImport, confirmImport, createImport, failedRowsCsv, rollbackImport, runProcessing, runValidation } from '@/server/services/imports';
import { verifyAuditChain } from '@/server/services/governance';
import { ctxFor, ensureRoles, makeUser } from '../helpers';

let ownerId: string;
beforeAll(async () => {
  await ensureRoles();
  ownerId = (await makeUser('platform_owner', null)).id;
});

const opts = { dedupeKeys: ['email', 'phone'] as ('email' | 'phone')[], onDuplicate: 'skip' as const, requireName: true, requireContact: true, requireEmail: false, requirePhone: false, defaultCountry: 'US', autoConfirm: false };

describe('import pipeline', () => {
  it('validates, de-duplicates, processes, reports and rolls back', async () => {
    const ctx = await ctxFor(ownerId);
    const csv = [
      'Name,Email,Phone,Company',
      'Ann One,ann@acme.test,4155550111,Acme',
      'Ann Dup,ANN@acme.test,,Acme',
      '=cmd|calc,bad,1,Evil',
      'Bob Two,,+44 7700 900123,Beta',
    ].join('\n');
    const { import: imp } = await createImport(ctx, { name: 'leads.csv', size: csv.length, buffer: Buffer.from(csv) });
    await configureImport(ctx, imp.id, { mapping: { Name: 'fullName', Email: 'email', Phone: 'phone', Company: 'company' }, options: opts, tags: ['batch-x'], source: 'Expo' });
    await runValidation(imp.id);
    const v = await withPlatform((tx) => tx.importBatch.findUniqueOrThrow({ where: { id: imp.id } }));
    expect([v.status, v.totalRows, v.validCount, v.duplicateCount, v.invalidCount]).toEqual(['PREVIEW_READY', 4, 2, 1, 1]);

    await confirmImport(ctx, imp.id);
    const done = await runProcessing(imp.id);
    expect([done?.status, done?.insertedCount, done?.skippedCount]).toEqual(['COMPLETED', 2, 1]);
    const leads = await withPlatform((tx) => tx.lead.findMany({ where: { importBatchId: imp.id }, include: { tags: { include: { tag: true } } } }));
    expect(leads.map((l) => l.phoneNormalized).sort()).toEqual(['+14155550111', '+447700900123']);
    expect(leads.every((l) => l.source === 'Expo' && l.tags.some((t) => t.tag.name === 'batch-x'))).toBe(true);

    const { csv: report } = await failedRowsCsv(ctx, imp.id);
    expect(report).toContain(`'=cmd|calc`);
    expect(report).not.toMatch(/(^|,)=cmd/m);

    // Re-running processing is a no-op (idempotent resume).
    await withPlatform((tx) => tx.importBatch.update({ where: { id: imp.id }, data: { status: 'PROCESSING' } }));
    await runProcessing(imp.id);
    expect(await withPlatform((tx) => tx.lead.count({ where: { importBatchId: imp.id } }))).toBe(2);

    const rb = await rollbackImport(ctx, imp.id, 'wrong file');
    expect(rb.archived).toBe(2);
    expect(await withPlatform((tx) => tx.lead.count({ where: { importBatchId: imp.id, archivedAt: null } }))).toBe(0);
  });

  it('rejects files that are not what they claim to be', async () => {
    const ctx = await ctxFor(ownerId);
    await expect(createImport(ctx, { name: 'x.csv', size: 6, buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]) })).rejects.toThrow(/csv/i);
    await expect(createImport(ctx, { name: 'x.exe', size: 3, buffer: Buffer.from('abc') })).rejects.toThrow();
    await expect(createImport(ctx, { name: 'x.csv', size: 0, buffer: Buffer.alloc(0) })).rejects.toThrow(/empty/);
  });
});

describe('audit log', () => {
  it('is append-only even for the application database role', async () => {
    await expect(withPlatform((tx) => tx.$executeRaw`UPDATE audit_events SET action = 'tampered'`)).resolves.toBe(0); // no UPDATE policy: zero rows visible to update
    const ev = await withPlatform((tx) => tx.auditEvent.findFirstOrThrow());
    await expect(withPlatform(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.audit_purge', 'off', true)`;
      return tx.$executeRaw`DELETE FROM audit_events WHERE id = ${ev.id}`;
    })).resolves.toBe(0);
    await expect(withPlatform((tx) => tx.$executeRaw`TRUNCATE audit_events`)).rejects.toThrow();
  });
  it('maintains an intact hash chain', async () => {
    const ctx = await ctxFor(ownerId);
    const res = await verifyAuditChain(ctx);
    expect(res.intact).toBe(true);
    expect(res.checked).toBeGreaterThan(5);
  });
  it('redacts secrets from audit payloads', async () => {
    const { redact } = await import('@/server/audit');
    expect(redact({ password: 'x', nested: { apiToken: 'y', ok: 1 } })).toEqual({ password: '[redacted]', nested: { apiToken: '[redacted]', ok: 1 } });
  });
});
