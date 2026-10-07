import { beforeAll, describe, expect, it } from 'vitest';
import { withPlatform } from '@/server/db';
import { createImport, getImport, runProcessing, runValidation, saveDraft, configureImport, importOptionsSchema } from '@/server/services/imports';
import { ctxFor, ensureRoles, makeUser } from '../helpers';

let ownerId: string;
beforeAll(async () => {
  await ensureRoles();
  ownerId = (await makeUser('platform_owner', null)).id;
});

describe('smart import', () => {
  it('auto-detects a messy Windows-1252, semicolon file with title rows and imports it hands-off', async () => {
    const ctx = await ctxFor(ownerId);
    const text = [
      'Lead export – Trade show',
      ';;;',
      'Nom complet;Adresse e-mail;Téléphone;Société;Pays',
      'José Álvarez;jose@acme.test;+34 612 345 678;Acme;ES',
      'Zoë Müller;zoe@beta.test;0151 23456789;Beta GmbH;Germany',
      'No Contact;;;Gamma;FR',
      'Ana Silva;ana@delta.test;+351 912 345 678;Delta;PT',
    ].join('\r\n');
    const buf = Buffer.from(text, 'latin1');
    const res = await createImport(ctx, { name: 'export.csv', size: buf.length, buffer: buf });
    const b = res.import;
    expect(b.encoding).toBe('Windows-1252');
    expect(b.delimiter).toBe(';');
    expect(b.headerRow).toBe(2); // the ';;;' line is blank and skipped
    expect(b.mapping).toMatchObject({ 'Adresse e-mail': 'email', 'Téléphone': 'phone', 'Pays': 'country' });

    await configureImport(ctx, b.id, { mapping: { ...(b.mapping as Record<string, string>), 'Nom complet': 'fullName', 'Société': 'company' }, options: importOptionsSchema.parse({ autoConfirm: true }), tags: [] });
    await runValidation(b.id);
    const queued = await withPlatform((tx) => tx.importBatch.findUniqueOrThrow({ where: { id: b.id } }));
    expect(queued.status).toBe('QUEUED'); // auto-confirmed: 1 of 4 rows invalid (25%)
    const done = await runProcessing(b.id);
    expect(done?.insertedCount).toBe(3);
    const zoe = await withPlatform((tx) => tx.lead.findFirstOrThrow({ where: { importBatchId: b.id, emailNormalized: 'zoe@beta.test' } }));
    expect([zoe.fullName, zoe.country, zoe.phoneNormalized]).toEqual(['Zoë Müller', 'Germany', '+4915123456789']);
  });

  it('pauses auto-import for review when too many rows are invalid, and drafts can be edited and resumed', async () => {
    const ctx = await ctxFor(ownerId);
    const csv = 'Name,Email,Phone\nAnn,ann@x.test,4155550100\nBad,,\nWorse,,\nBo,bo@x.test,4155550101';
    const { import: b } = await createImport(ctx, { name: 'x.csv', size: csv.length, buffer: Buffer.from(csv) });
    expect(b.draftStep).toBe('file');
    await saveDraft(ctx, b.id, { step: 'rules', mapping: { ...(b.mapping as Record<string, string>), Phone: 'ignore' } });
    const resumed = await getImport(b.id);
    expect(resumed.import.draftStep).toBe('rules');
    expect((resumed.import.mapping as Record<string, string>).Phone).toBe('ignore');
    await configureImport(ctx, b.id, { mapping: resumed.import.mapping as Record<string, string>, options: importOptionsSchema.parse({ autoConfirm: true }), tags: [] });
    await runValidation(b.id);
    const v = await withPlatform((tx) => tx.importBatch.findUniqueOrThrow({ where: { id: b.id } }));
    expect(v.status).toBe('PREVIEW_READY');
    expect(v.error).toMatch(/paused for review/);
    // Going back to edit after validation turns it back into a draft.
    const edited = await saveDraft(ctx, b.id, { mapping: { ...(v.mapping as Record<string, string>), Phone: 'phone' } });
    expect(edited.status).toBe('UPLOADED');
  });

  it('normalises countries and parses phones using each row’s country', async () => {
    const ctx = await ctxFor(ownerId);
    const csv = 'Full Name,Email,Mobile,Country\nPriya K,priya@x.test,98765 43210,India\nTom B,tom@x.test,07700 900456,UK';
    const { import: b } = await createImport(ctx, { name: 'c.csv', size: csv.length, buffer: Buffer.from(csv) });
    await configureImport(ctx, b.id, { mapping: b.mapping as Record<string, string>, options: importOptionsSchema.parse({ autoConfirm: true }), tags: [] });
    await runValidation(b.id);
    await runProcessing(b.id);
    const leads = await withPlatform((tx) => tx.lead.findMany({ where: { importBatchId: b.id }, orderBy: { fullName: 'asc' } }));
    expect(leads.map((l) => [l.country, l.phoneNormalized])).toEqual([['India', '+919876543210'], ["United Kingdom", "+447700900456"]]);
  });
});
