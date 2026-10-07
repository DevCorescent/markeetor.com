import { Prisma, type ImportBatch, type ImportRowStatus, type Priority } from '@prisma/client';
import { isSupportedCountry } from 'libphonenumber-js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { audit } from '../audit';
import type { AuthContext } from '../auth/context';
import { shortCode } from '../crypto';
import { withPlatform, type Tx } from '../db';
import { AppError, notFound } from '../errors';
import { enqueue } from '../jobs/queues';
import { logger } from '../logger';
import { getSetting } from '../settings';
import { localPath, putBuffer, removeFile } from '../storage';
import { ACTIVITY } from './activity';
import { analyze, detectKind, iterateRows, type FileKind } from './import-parse';
import { detectColumns, lookupCountry, toUtf8 } from './import-detect';
import { cleanText, normalizeEmail, normalizePhone, titleCaseName, toCsv } from './normalize';
import { notifyUsers } from './notifications';

export const IMPORT_FIELDS = [
  { key: 'fullName', label: 'Full name', synonyms: ['name', 'full name', 'fullname', 'contact name', 'lead name', 'customer name'] },
  { key: 'firstName', label: 'First name', synonyms: ['first name', 'firstname', 'given name', 'first'] },
  { key: 'lastName', label: 'Last name', synonyms: ['last name', 'lastname', 'surname', 'family name', 'last'] },
  { key: 'email', label: 'Email', synonyms: ['email', 'e-mail', 'email address', 'mail', 'work email'] },
  { key: 'phone', label: 'Phone', synonyms: ['phone', 'phone number', 'mobile', 'mobile number', 'cell', 'telephone', 'contact number', 'whatsapp'] },
  { key: 'secondaryPhone', label: 'Secondary phone', synonyms: ['secondary phone', 'alternate phone', 'alt phone', 'phone 2', 'other phone', 'landline'] },
  { key: 'company', label: 'Company', synonyms: ['company', 'company name', 'organization', 'organisation', 'business', 'account'] },
  { key: 'jobTitle', label: 'Job title', synonyms: ['job title', 'title', 'designation', 'position', 'role'] },
  { key: 'city', label: 'City', synonyms: ['city', 'town'] },
  { key: 'state', label: 'State / region', synonyms: ['state', 'region', 'province', 'county'] },
  { key: 'country', label: 'Country', synonyms: ['country', 'nation'] },
  { key: 'industry', label: 'Industry', synonyms: ['industry', 'sector', 'vertical'] },
  { key: 'source', label: 'Source', synonyms: ['source', 'lead source', 'channel', 'utm source'] },
  { key: 'campaign', label: 'Campaign', synonyms: ['campaign', 'campaign name', 'utm campaign'] },
  { key: 'score', label: 'Score', synonyms: ['score', 'lead score', 'rating'] },
  { key: 'priority', label: 'Priority', synonyms: ['priority', 'urgency'] },
  { key: 'tags', label: 'Tags (comma-separated)', synonyms: ['tags', 'labels', 'tag'] },
] as const;
export type ImportFieldKey = (typeof IMPORT_FIELDS)[number]['key'];
const FIELD_KEYS = new Set<string>(IMPORT_FIELDS.map((f) => f.key));

export const importOptionsSchema = z.object({
  dedupeKeys: z.array(z.enum(['email', 'phone'])).min(1).max(2).default(['email', 'phone']),
  onDuplicate: z.enum(['skip', 'update', 'create']).default('skip'),
  requireName: z.boolean().default(true),
  requireContact: z.boolean().default(true),
  requireEmail: z.boolean().default(false),
  requirePhone: z.boolean().default(false),
  defaultCountry: z.string().regex(/^[A-Z]{2}$/).default('US'),
  /** Import automatically once validation finishes, if at most 25% of rows are invalid. */
  autoConfirm: z.boolean().default(false),
});
export type ImportOptions = z.infer<typeof importOptionsSchema>;

export const configureSchema = z.object({
  mapping: z.record(z.string().max(200), z.string().max(80)),
  options: importOptionsSchema,
  source: z.string().trim().max(120).nullable().optional(),
  campaign: z.string().trim().max(120).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  saveTemplateName: z.string().trim().min(2).max(80).optional(),
});

export function suggestMapping(headers: string[]): Record<string, string> {
  const used = new Set<string>();
  const out: Record<string, string> = {};
  for (const h of headers) {
    const norm = h.toLowerCase().replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
    const match = IMPORT_FIELDS.find((f) => !used.has(f.key) && (f.synonyms as readonly string[]).includes(norm));
    if (match) {
      out[h] = match.key;
      used.add(match.key);
    } else {
      out[h] = 'ignore';
    }
  }
  return out;
}

// ── Upload ──────────────────────────────────────────────────────────

export async function createImport(ctx: AuthContext, file: { name: string; size: number; buffer: Buffer }) {
  const maxMb = Number(process.env.MAX_UPLOAD_MB ?? 25);
  if (file.size === 0) throw new AppError('VALIDATION_FAILED', 'The file is empty');
  if (file.size > maxMb * 1024 * 1024) throw new AppError('PAYLOAD_TOO_LARGE', `Files are limited to ${maxMb} MB`);
  const safeName = file.name.replace(/[^\w.\- ()]/g, '_').slice(0, 180);
  const kind = detectKind(safeName, file.buffer.subarray(0, 8192));
  if (!kind) throw new AppError('UNSUPPORTED_MEDIA', 'Only .csv, .tsv, .txt and .xlsx files are accepted');

  const id = randomUUID();
  const key = `imports/${id}.${kind}`;
  // Text files are normalised to UTF-8 on arrival (UTF-16 and Windows-1252 exports are common from Excel).
  let encoding: string | null = null;
  if (kind === 'csv') {
    const t = toUtf8(file.buffer);
    encoding = t.encoding;
    await putBuffer(key, Buffer.from(t.text, 'utf8'));
  } else {
    await putBuffer(key, file.buffer);
  }
  const { defaultCountry } = await getSetting('imports.policy');
  let a: Awaited<ReturnType<typeof analyze>>;
  try {
    a = await analyze(localPath(key), kind);
  } catch (err) {
    await removeFile(key);
    logger.warn({ err }, 'import analysis failed');
    throw new AppError('VALIDATION_FAILED', 'The file could not be read. Check that it is a valid, unencrypted CSV or XLSX file.');
  }
  if (!a.headers.length || !a.sample.length) {
    await removeFile(key);
    throw new AppError('VALIDATION_FAILED', 'No data rows were found in the file');
  }
  const det = detectColumns(a.headers, a.sample, defaultCountry);

  const batch = await withPlatform(async (tx) => {
    let code = shortCode('IMP');
    while (await tx.importBatch.findUnique({ where: { code } })) code = shortCode('IMP');
    const b = await tx.importBatch.create({
      data: {
        id, code, fileName: safeName, fileSize: file.size, fileType: kind, storageKey: key, headers: a.headers, mapping: det.mapping,
        options: { ...importOptionsSchema.parse({}), defaultCountry }, draftStep: 'file', sheetName: a.sheetName, sheets: a.sheets, headerRow: a.headerRow,
        delimiter: a.delimiter, encoding, detection: det.details as unknown as Prisma.InputJsonValue, createdById: ctx.user.id,
      },
    });
    await audit(tx, ctx, { action: 'import.uploaded', targetType: 'import', targetId: b.id, organizationId: null, metadata: { fileName: safeName, size: file.size, kind, encoding, delimiter: a.delimiter, sheet: a.sheetName, headerRow: a.headerRow } });
    return b;
  });
  return { import: batch, headers: a.headers, sample: a.sample.slice(0, 15).map((r) => r.map((c) => c.slice(0, 120))), detection: det.details };
}

/** Whether the auto-detected mapping is complete enough to import without human review. */
export function mappingReady(mapping: Record<string, string>, o: ImportOptions) {
  const t = new Set(Object.values(mapping));
  const problems: string[] = [];
  if (o.requireName && !t.has('fullName') && !t.has('firstName') && !t.has('lastName')) problems.push('No name column detected');
  if (o.requireContact && !t.has('email') && !t.has('phone')) problems.push('No email or phone column detected');
  if (o.requireEmail && !t.has('email')) problems.push('No email column detected');
  if (o.requirePhone && !t.has('phone')) problems.push('No phone column detected');
  return problems;
}

// ── Drafts ─────────────────────────────────────────────────────────

export const draftSchema = z.object({
  step: z.enum(['file', 'mapping', 'rules', 'review']).optional(),
  mapping: z.record(z.string().max(200), z.string().max(80)).optional(),
  options: importOptionsSchema.partial().optional(),
  source: z.string().trim().max(120).nullable().optional(),
  campaign: z.string().trim().max(120).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  sheetName: z.string().max(200).nullable().optional(),
  headerRow: z.number().int().min(0).max(20).optional(),
  redetect: z.boolean().optional(),
});

/**
 * Saves wizard progress without validating, so users can leave and resume or step back freely.
 * Changing the sheet or header row re-analyses the file and re-runs column detection.
 */
export async function saveDraft(ctx: AuthContext, id: string, input: z.infer<typeof draftSchema>) {
  const b = await withPlatform((tx) => tx.importBatch.findUnique({ where: { id } }));
  if (!b) throw notFound('Import');
  if (b.confirmedAt || !['UPLOADED', 'PREVIEW_READY', 'FAILED'].includes(b.status)) throw new AppError('CONFLICT', 'This import can no longer be edited');
  const opts = importOptionsSchema.parse({ ...(b.options as object), ...(input.options ?? {}) });
  const data: Prisma.ImportBatchUpdateInput = { options: opts };
  if (input.step) data.draftStep = input.step;
  if (input.source !== undefined) data.source = input.source;
  if (input.campaign !== undefined) data.campaign = input.campaign;
  if (input.tags) data.tags = input.tags;
  const structural = (input.sheetName !== undefined && input.sheetName !== b.sheetName) || (input.headerRow !== undefined && input.headerRow !== b.headerRow);
  if (structural || input.redetect) {
    if (!b.storageKey || b.fileDeletedAt) throw new AppError('CONFLICT', 'The uploaded file is no longer available');
    const a = await analyze(localPath(b.storageKey), b.fileType as FileKind, { sheetName: input.sheetName ?? b.sheetName, headerRow: input.headerRow ?? (structural ? null : b.headerRow), delimiter: b.delimiter });
    if (!a.sample.length) throw new AppError('VALIDATION_FAILED', 'That selection contains no data rows');
    const det = detectColumns(a.headers, a.sample, opts.defaultCountry);
    Object.assign(data, { headers: a.headers, headerRow: a.headerRow, sheetName: a.sheetName, mapping: det.mapping, detection: det.details as unknown as Prisma.InputJsonValue });
  } else if (input.mapping) {
    data.mapping = Object.fromEntries(Object.entries(input.mapping).filter(([h]) => b.headers.includes(h)));
  }
  // Editing after validation invalidates the preview: back to an unvalidated draft.
  if (b.status !== 'UPLOADED' && (structural || input.mapping || input.redetect || input.options)) data.status = 'UPLOADED';
  return withPlatform((tx) => tx.importBatch.update({ where: { id }, data }));
}

// ── Configure + validate ────────────────────────────────────────────

export async function configureImport(ctx: AuthContext, id: string, input: z.infer<typeof configureSchema>) {
  return withPlatform(async (tx) => {
    const batch = await tx.importBatch.findUnique({ where: { id } });
    if (!batch) throw notFound('Import');
    if (!['UPLOADED', 'PREVIEW_READY', 'FAILED'].includes(batch.status) || batch.confirmedAt) throw new AppError('CONFLICT', `This import is ${batch.status.toLowerCase()} and can no longer be reconfigured`);
    if (!batch.storageKey || batch.fileDeletedAt) throw new AppError('CONFLICT', 'The uploaded file is no longer available. Upload it again.');

    const mapping: Record<string, string> = {};
    const targets = new Set<string>();
    for (const [header, field] of Object.entries(input.mapping)) {
      if (!batch.headers.includes(header)) continue;
      if (field === 'ignore') continue;
      const ok = FIELD_KEYS.has(field) || /^custom:[a-z][a-z0-9_]{0,39}$/.test(field);
      if (!ok) throw new AppError('VALIDATION_FAILED', `Unknown target field "${field}"`);
      if (FIELD_KEYS.has(field) && targets.has(field)) throw new AppError('VALIDATION_FAILED', `"${field}" is mapped more than once`);
      targets.add(field);
      mapping[header] = field;
    }
    const o = input.options;
    if (o.requireName && !targets.has('fullName') && !(targets.has('firstName') || targets.has('lastName'))) throw new AppError('VALIDATION_FAILED', 'Map a name column (full name, or first/last name)');
    if (o.requireContact && !targets.has('email') && !targets.has('phone')) throw new AppError('VALIDATION_FAILED', 'Map at least one contact column (email or phone)');
    if (o.requireEmail && !targets.has('email')) throw new AppError('VALIDATION_FAILED', 'Email is required but not mapped');
    if (o.requirePhone && !targets.has('phone')) throw new AppError('VALIDATION_FAILED', 'Phone is required but not mapped');

    const updated = await tx.importBatch.update({
      where: { id },
      data: {
        mapping, options: o, source: input.source ?? null, campaign: input.campaign ?? null, tags: input.tags, draftStep: 'review',
        status: 'VALIDATING', error: null, totalRows: 0, validCount: 0, invalidCount: 0, duplicateCount: 0,
      },
    });
    if (input.saveTemplateName) {
      await tx.importTemplate.upsert({
        where: { name: input.saveTemplateName },
        create: { name: input.saveTemplateName, mapping, options: o, createdById: ctx.user.id },
        update: { mapping, options: o },
      });
    }
    await audit(tx, ctx, { action: 'import.configured', targetType: 'import', targetId: id, organizationId: null, after: { mapping, options: o, source: input.source, campaign: input.campaign, tags: input.tags } });
    return updated;
  }).then(async (b) => {
    await enqueue('imports', 'validate', { importId: id }, { jobId: `import-validate-${id}-${Date.now()}`, attempts: 2 });
    return b;
  });
}

type NormalizedRow = {
  fullName: string | null;
  email: string | null;
  emailNormalized: string | null;
  phone: string | null;
  phoneNormalized: string | null;
  secondaryPhone: string | null;
  company: string | null;
  jobTitle: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  industry: string | null;
  source: string | null;
  campaign: string | null;
  score: number;
  priority: Priority;
  tags: string[];
  customFields: Record<string, string>;
  qualityIssues: string[];
};

const PRIORITY_MAP: Record<string, Priority> = { low: 'LOW', l: 'LOW', '1': 'LOW', medium: 'MEDIUM', med: 'MEDIUM', normal: 'MEDIUM', m: 'MEDIUM', '2': 'MEDIUM', high: 'HIGH', h: 'HIGH', '3': 'HIGH', urgent: 'URGENT', critical: 'URGENT', '4': 'URGENT' };

export function normalizeRow(cells: Record<string, string>, mapping: Record<string, string>, opts: ImportOptions, batch: Pick<ImportBatch, 'source' | 'campaign'>) {
  const get = (field: string) => {
    for (const [h, f] of Object.entries(mapping)) if (f === field) return cells[h] ?? '';
    return '';
  };
  const errors: string[] = [];
  const issues: string[] = [];
  let fullName = cleanText(get('fullName'), 200);
  if (!fullName) fullName = cleanText([get('firstName'), get('lastName')].filter(Boolean).join(' '), 200);
  if (fullName) fullName = titleCaseName(fullName);

  const rawEmail = cleanText(get('email'), 254);
  const e = normalizeEmail(rawEmail);
  // Country codes/aliases become full names, and the row's own country drives phone parsing.
  const rawCountry = cleanText(get('country'), 80);
  const ctry = lookupCountry(rawCountry);
  const region = ctry?.code && isSupportedCountry(ctry.code) ? ctry.code : opts.defaultCountry;
  const rawPhone = cleanText(get('phone'), 40);
  const p = normalizePhone(rawPhone, region);
  const sp = normalizePhone(cleanText(get('secondaryPhone'), 40), region);

  if (rawEmail && e.error) issues.push(`Invalid email "${rawEmail.slice(0, 60)}"`);
  if (rawPhone && p.error) issues.push(`Invalid phone "${rawPhone.slice(0, 30)}"`);
  if (opts.requireName && !fullName) errors.push('Name is missing');
  if (opts.requireEmail && !e.value) errors.push(rawEmail ? 'Email is invalid' : 'Email is missing');
  if (opts.requirePhone && !p.value) errors.push(rawPhone ? 'Phone is invalid' : 'Phone is missing');
  if (opts.requireContact && !e.value && !p.value) errors.push('No valid email or phone');

  const scoreRaw = get('score');
  let score = 0;
  if (scoreRaw) {
    const n = Number(scoreRaw.replace(/[^\d.-]/g, ''));
    if (Number.isFinite(n)) score = Math.max(0, Math.min(100, Math.round(n)));
    else issues.push('Score is not a number');
  }
  const priority = PRIORITY_MAP[get('priority').trim().toLowerCase()] ?? 'MEDIUM';
  const customFields: Record<string, string> = {};
  for (const [h, f] of Object.entries(mapping)) {
    if (f.startsWith('custom:')) {
      const v = cleanText(cells[h], 500);
      if (v) customFields[f.slice(7)] = v;
    }
  }
  const row: NormalizedRow = {
    fullName,
    email: e.value ? rawEmail : null,
    emailNormalized: e.value,
    phone: p.value, // stored in E.164
    phoneNormalized: p.value,
    secondaryPhone: sp.value,
    company: cleanText(get('company')),
    jobTitle: cleanText(get('jobTitle'), 120),
    city: cleanText(get('city'), 80),
    state: cleanText(get('state'), 80),
    country: ctry?.name ?? rawCountry,
    industry: cleanText(get('industry'), 80),
    source: cleanText(get('source'), 120) ?? batch.source ?? null,
    campaign: cleanText(get('campaign'), 120) ?? batch.campaign ?? null,
    score,
    priority,
    tags: get('tags').split(/[,;|]/).map((t) => cleanText(t, 40)).filter((t): t is string => Boolean(t)).slice(0, 10),
    customFields,
    qualityIssues: issues,
  };
  return { row, errors };
}

const dupKeys = (r: Pick<NormalizedRow, 'emailNormalized' | 'phoneNormalized'>, keys: ImportOptions['dedupeKeys']) =>
  [keys.includes('email') && r.emailNormalized ? `e:${r.emailNormalized}` : null, keys.includes('phone') && r.phoneNormalized ? `p:${r.phoneNormalized}` : null].filter(Boolean) as string[];

async function findExisting(tx: Tx, rows: Pick<NormalizedRow, 'emailNormalized' | 'phoneNormalized'>[], keys: ImportOptions['dedupeKeys']) {
  const emails = keys.includes('email') ? [...new Set(rows.map((r) => r.emailNormalized).filter(Boolean) as string[])] : [];
  const phones = keys.includes('phone') ? [...new Set(rows.map((r) => r.phoneNormalized).filter(Boolean) as string[])] : [];
  if (!emails.length && !phones.length) return new Map<string, string>();
  const found = await tx.lead.findMany({
    where: { mergedIntoId: null, OR: [...(emails.length ? [{ emailNormalized: { in: emails } }] : []), ...(phones.length ? [{ phoneNormalized: { in: phones } }] : [])] },
    select: { id: true, emailNormalized: true, phoneNormalized: true },
    orderBy: { createdAt: 'asc' },
  });
  const map = new Map<string, string>();
  for (const l of found) {
    if (l.emailNormalized && !map.has(`e:${l.emailNormalized}`)) map.set(`e:${l.emailNormalized}`, l.id);
    if (l.phoneNormalized && !map.has(`p:${l.phoneNormalized}`)) map.set(`p:${l.phoneNormalized}`, l.id);
  }
  return map;
}

/** Worker: parses the whole file, normalizes and validates every row, and records expected outcomes for preview. */
export async function runValidation(importId: string) {
  const batch = await withPlatform((tx) => tx.importBatch.findUnique({ where: { id: importId } }));
  if (!batch || batch.status !== 'VALIDATING' || !batch.storageKey) return;
  const { maxRows } = await getSetting('imports.policy');
  const opts = importOptionsSchema.parse(batch.options);
  const mapping = batch.mapping as Record<string, string>;

  await withPlatform((tx) => tx.importRow.deleteMany({ where: { importId } }), { timeout: 120_000 });

  const seen = new Map<string, number>();
  let rowNumber = 0;
  let headers: string[] | null = null;
  let buffer: { rowNumber: number; raw: Record<string, string>; row: NormalizedRow; errors: string[] }[] = [];
  const counts = { total: 0, valid: 0, invalid: 0, duplicate: 0 };

  const flush = async () => {
    if (!buffer.length) return;
    const chunk = buffer;
    buffer = [];
    await withPlatform(async (tx) => {
      const existing = await findExisting(tx, chunk.filter((c) => !c.errors.length).map((c) => c.row), opts.dedupeKeys);
      const data: Prisma.ImportRowCreateManyInput[] = chunk.map((c) => {
        let status: ImportRowStatus = c.errors.length ? 'INVALID' : 'VALID';
        let matchLeadId: string | null = null;
        const errors = [...c.errors];
        if (status === 'VALID') {
          const keys = dupKeys(c.row, opts.dedupeKeys);
          const inFile = keys.map((k) => seen.get(k)).find((n) => n !== undefined && n !== c.rowNumber);
          matchLeadId = keys.map((k) => existing.get(k)).find(Boolean) ?? null;
          if (matchLeadId) {
            status = 'DUPLICATE';
            errors.push('Matches an existing lead');
          } else if (inFile) {
            status = 'DUPLICATE';
            errors.push(`Duplicate of row ${inFile} in this file`);
          }
        }
        if (status === 'VALID') counts.valid++;
        else if (status === 'DUPLICATE') counts.duplicate++;
        else counts.invalid++;
        return { importId, rowNumber: c.rowNumber, raw: c.raw, normalized: c.row as unknown as Prisma.InputJsonValue, status, errors: [...errors, ...c.row.qualityIssues.map((i) => `Warning: ${i}`)], matchLeadId };
      });
      await tx.importRow.createMany({ data });
      await tx.importBatch.update({ where: { id: importId }, data: { totalRows: counts.total, validCount: counts.valid, invalidCount: counts.invalid, duplicateCount: counts.duplicate } });
    }, { timeout: 60_000 });
  };

  let skip = batch.headerRow;
  rowNumber = batch.headerRow;
  headers = batch.headers;
  try {
    for await (const cells of iterateRows(localPath(batch.storageKey), batch.fileType as FileKind, { delimiter: batch.delimiter, sheetName: batch.sheetName })) {
      if (skip > 0) {
        skip--;
        continue;
      }
      rowNumber++;
      counts.total++;
      if (counts.total > maxRows) throw new AppError('VALIDATION_FAILED', `The file exceeds the ${maxRows.toLocaleString()}-row limit`);
      const raw: Record<string, string> = {};
      headers!.forEach((h, i) => (raw[h] = (cells[i] ?? '').slice(0, 500)));
      const { row, errors } = normalizeRow(raw, mapping, opts, batch);
      if (!errors.length) {
        for (const k of dupKeys(row, opts.dedupeKeys)) if (!seen.has(k)) seen.set(k, rowNumber);
      }
      buffer.push({ rowNumber, raw, row, errors });
      if (buffer.length >= 1000) await flush();
    }
    await flush();
    await withPlatform((tx) => tx.importBatch.update({ where: { id: importId }, data: { status: counts.total ? 'PREVIEW_READY' : 'FAILED', error: counts.total ? null : 'The file contains no data rows', totalRows: counts.total } }));
    // Hands-off mode: import straight away when the file is clean enough; otherwise stop for review.
    if (opts.autoConfirm && counts.total) {
      const writable = counts.valid + (opts.onDuplicate === 'skip' ? 0 : counts.duplicate);
      if (writable > 0 && counts.invalid / counts.total <= 0.25) {
        await withPlatform(async (tx) => {
          const res = await tx.importBatch.updateMany({ where: { id: importId, status: 'PREVIEW_READY' }, data: { status: 'QUEUED', confirmedAt: new Date() } });
          if (res.count) await audit(tx, { user: { id: batch.createdById, email: '', name: 'auto-import', mfaEnabled: false } }, { action: 'import.auto_confirmed', targetType: 'import', targetId: importId, organizationId: null, metadata: { ...counts } });
        });
        await enqueue('imports', 'process', { importId }, { jobId: `import-process-${importId}` });
      } else {
        await withPlatform((tx) => tx.importBatch.update({ where: { id: importId }, data: { error: `Auto-import paused for review: ${counts.invalid} of ${counts.total} rows are invalid` } }));
      }
    }
  } catch (err) {
    const message = err instanceof AppError ? err.message : 'Validation failed while reading the file';
    logger.error({ err, importId }, 'import validation failed');
    await withPlatform((tx) => tx.importBatch.update({ where: { id: importId }, data: { status: 'FAILED', error: message } }));
  }
}

// ── Confirm + process ───────────────────────────────────────────────

export async function confirmImport(ctx: AuthContext, id: string) {
  await withPlatform(async (tx) => {
    const res = await tx.importBatch.updateMany({ where: { id, status: 'PREVIEW_READY' }, data: { status: 'QUEUED', confirmedAt: new Date() } });
    if (!res.count) throw new AppError('CONFLICT', 'This import is not ready to be confirmed');
    const b = await tx.importBatch.findUniqueOrThrow({ where: { id } });
    await audit(tx, ctx, { action: 'import.confirmed', targetType: 'import', targetId: id, organizationId: null, metadata: { valid: b.validCount, duplicates: b.duplicateCount, invalid: b.invalidCount, onDuplicate: (b.options as ImportOptions).onDuplicate } });
  });
  await enqueue('imports', 'process', { importId: id }, { jobId: `import-process-${id}` });
}

export async function retryImport(ctx: AuthContext, id: string) {
  const b = await withPlatform((tx) => tx.importBatch.findUnique({ where: { id } }));
  if (!b) throw notFound('Import');
  if (b.status !== 'FAILED' || !b.confirmedAt) throw new AppError('CONFLICT', 'Only failed imports that were confirmed can be retried');
  await withPlatform(async (tx) => {
    await tx.importBatch.update({ where: { id }, data: { status: 'QUEUED', error: null } });
    await audit(tx, ctx, { action: 'import.retried', targetType: 'import', targetId: id, organizationId: null });
  });
  await enqueue('imports', 'process', { importId: id }, { jobId: `import-process-${id}-${Date.now()}` });
}

export async function cancelImport(ctx: AuthContext, id: string) {
  const b = await withPlatform(async (tx) => {
    const res = await tx.importBatch.updateMany({ where: { id, status: { in: ['UPLOADED', 'VALIDATING', 'PREVIEW_READY'] }, confirmedAt: null }, data: { status: 'CANCELLED', fileDeletedAt: new Date() } });
    if (!res.count) throw new AppError('CONFLICT', 'Only unconfirmed imports can be cancelled');
    await tx.importRow.deleteMany({ where: { importId: id } });
    await audit(tx, ctx, { action: 'import.cancelled', targetType: 'import', targetId: id, organizationId: null });
    return tx.importBatch.findUniqueOrThrow({ where: { id } });
  });
  if (b.storageKey) await removeFile(b.storageKey).catch(() => null);
}

/** Worker: inserts/updates leads in chunked transactions. Each row's status changes in the same transaction as its lead write, so retries resume safely. */
export async function runProcessing(importId: string) {
  const batch = await withPlatform((tx) => tx.importBatch.findUnique({ where: { id: importId } }));
  if (!batch || !['QUEUED', 'PROCESSING'].includes(batch.status)) return;
  const opts = importOptionsSchema.parse(batch.options);
  await withPlatform((tx) => tx.importBatch.update({ where: { id: importId }, data: { status: 'PROCESSING', startedAt: batch.startedAt ?? new Date() } }));

  const batchTagIds = await withPlatform(async (tx) => {
    const ids: string[] = [];
    for (const name of batch.tags) {
      const t = (await tx.tag.findFirst({ where: { organizationId: null, name } })) ?? (await tx.tag.create({ data: { organizationId: null, name } }));
      ids.push(t.id);
    }
    return ids;
  });
  const tagCache = new Map<string, string>();

  for (;;) {
    const done = await withPlatform(async (tx) => {
      const rows = await tx.importRow.findMany({ where: { importId, status: { in: ['VALID', 'DUPLICATE'] } }, orderBy: { rowNumber: 'asc' }, take: 500 });
      if (!rows.length) return true;
      const normalized = rows.map((r) => r.normalized as unknown as NormalizedRow);
      const existing = await findExisting(tx, normalized, opts.dedupeKeys);
      const inserts: Prisma.LeadCreateManyInput[] = [];
      const results: { id: string; status: ImportRowStatus; leadId: string | null; before: Prisma.InputJsonValue | null }[] = [];
      const seenInChunk = new Map<string, string>();
      const rowTags = new Map<string, string[]>();
      let inserted = 0, updated = 0, skipped = 0;

      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const n = normalized[i];
        const keys = dupKeys(n, opts.dedupeKeys);
        const matchId = keys.map((k) => existing.get(k) ?? seenInChunk.get(k)).find(Boolean) ?? null;
        const isDup = Boolean(matchId) || r.status === 'DUPLICATE';
        const leadData = {
          fullName: n.fullName ?? 'Unknown', email: n.email, emailNormalized: n.emailNormalized, phone: n.phone, phoneNormalized: n.phoneNormalized,
          secondaryPhone: n.secondaryPhone, company: n.company, jobTitle: n.jobTitle, city: n.city, state: n.state, country: n.country,
          industry: n.industry, source: n.source, campaign: n.campaign, score: n.score, priority: n.priority,
          quality: n.qualityIssues.length && !n.emailNormalized && !n.phoneNormalized ? ('INVALID' as const) : ('VALID' as const),
          qualityIssues: n.qualityIssues, customFields: n.customFields,
        };
        if (isDup && opts.onDuplicate === 'skip') {
          results.push({ id: r.id, status: 'SKIPPED', leadId: matchId, before: null });
          skipped++;
          continue;
        }
        if (isDup && opts.onDuplicate === 'update' && matchId) {
          const current = await tx.lead.findUnique({ where: { id: matchId } });
          if (!current || current.mergedIntoId) {
            results.push({ id: r.id, status: 'SKIPPED', leadId: null, before: null });
            skipped++;
            continue;
          }
          const patch: Record<string, unknown> = {};
          const before: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(leadData)) {
            if (['quality', 'qualityIssues', 'customFields', 'priority', 'score'].includes(k)) continue;
            if (v != null && v !== '' && (current as Record<string, unknown>)[k] !== v) {
              patch[k] = v;
              before[k] = (current as Record<string, unknown>)[k];
            }
          }
          if (Object.keys(n.customFields).length) {
            patch.customFields = { ...(current.customFields as object), ...n.customFields };
            before.customFields = current.customFields;
          }
          if (Object.keys(patch).length) await tx.lead.update({ where: { id: matchId }, data: patch });
          results.push({ id: r.id, status: 'UPDATED', leadId: matchId, before: before as Prisma.InputJsonValue });
          updated++;
          continue;
        }
        if (isDup && opts.onDuplicate === 'update' && !matchId) {
          // In-file duplicate whose first occurrence hasn't been written yet in a prior chunk: skip.
          results.push({ id: r.id, status: 'SKIPPED', leadId: null, before: null });
          skipped++;
          continue;
        }
        const leadId = randomUUID();
        inserts.push({ id: leadId, ...leadData, importBatchId: importId, createdById: batch.createdById, duplicateOfId: isDup ? matchId : null });
        rowTags.set(leadId, n.tags);
        for (const k of keys) if (!seenInChunk.has(k)) seenInChunk.set(k, leadId);
        results.push({ id: r.id, status: 'INSERTED', leadId, before: null });
        inserted++;
      }

      if (inserts.length) {
        await tx.lead.createMany({ data: inserts });
        const tagRows: { leadId: string; tagId: string }[] = [];
        for (const ins of inserts) {
          for (const tagId of batchTagIds) tagRows.push({ leadId: ins.id!, tagId });
          for (const name of rowTags.get(ins.id!) ?? []) {
            let tid = tagCache.get(name);
            if (!tid) {
              const t = (await tx.tag.findFirst({ where: { organizationId: null, name } })) ?? (await tx.tag.create({ data: { organizationId: null, name } }));
              tid = t.id;
              tagCache.set(name, tid);
            }
            tagRows.push({ leadId: ins.id!, tagId: tid });
          }
        }
        if (tagRows.length) await tx.leadTag.createMany({ data: tagRows, skipDuplicates: true });
        await tx.activity.createMany({
          data: inserts.map((ins) => ({ leadId: ins.id!, actorId: batch.createdById, type: ACTIVITY.LEAD_IMPORTED, verification: 'SYSTEM_VERIFIED' as const, summary: `Imported from ${batch.fileName} (${batch.code})`, data: { importId } })),
        });
      }
      await tx.$executeRaw`
        UPDATE import_rows AS r SET status = v.status::"ImportRowStatus", "leadId" = v.lead_id, before = v.before::jsonb
        FROM unnest(${results.map((x) => x.id)}::text[], ${results.map((x) => x.status)}::text[], ${results.map((x) => x.leadId)}::text[], ${results.map((x) => (x.before ? JSON.stringify(x.before) : null))}::text[])
          AS v(id, status, lead_id, before)
        WHERE r.id = v.id`;
      await tx.importBatch.update({
        where: { id: importId },
        data: { processedRows: { increment: rows.length }, insertedCount: { increment: inserted }, updatedCount: { increment: updated }, skippedCount: { increment: skipped } },
      });
      return false;
    }, { timeout: 120_000 });
    if (done) break;
  }

  const final = await withPlatform(async (tx) => {
    const failed = await tx.importRow.count({ where: { importId, status: 'FAILED' } });
    const b = await tx.importBatch.update({ where: { id: importId }, data: { status: 'COMPLETED', completedAt: new Date(), failedCount: failed } });
    await audit(tx, { user: { id: b.createdById, email: '', name: 'import worker', mfaEnabled: false } }, {
      action: 'import.completed', targetType: 'import', targetId: importId, organizationId: null,
      metadata: { inserted: b.insertedCount, updated: b.updatedCount, skipped: b.skippedCount, invalid: b.invalidCount },
    });
    await notifyUsers([b.createdById], { type: 'IMPORT_COMPLETED', title: `Import ${b.code} completed`, body: `${b.insertedCount} inserted · ${b.updatedCount} updated · ${b.skippedCount} skipped · ${b.invalidCount} invalid`, link: `/admin/imports/${b.id}` }, tx);
    return b;
  });
  await enqueue('distribution', 'on-import', { importId }, { jobId: `rules-on-import-${importId}` }).catch(() => null);
  // Welcome emails (Admin → Email → Welcome emails) for the leads this import added.
  if (final.insertedCount > 0) await import('./welcome').then((m) => m.queueWelcomeForImport(importId)).catch((err) => logger.error({ err, importId }, 'failed to queue welcome emails'));
  // Email endpoints listening for `import.completed` / `lead.created`.
  await import('./endpoints').then((m) => m.emitImportEvents(importId)).catch(() => null);
  if (final.insertedCount > 0) await import('./enrichment').then((m) => m.scheduleImportEnrichment(importId)).catch(() => null);
  // Tell clients about newly available leads once automated rules have had their turn.
  if (final.insertedCount > 0) await import('./announcements').then((m) => m.scheduleNewLeadsAnnouncement()).catch(() => null);
  return final;
}

export async function markImportFailed(importId: string, message: string) {
  await withPlatform(async (tx) => {
    const b = await tx.importBatch.update({ where: { id: importId }, data: { status: 'FAILED', error: message.slice(0, 500) } });
    await notifyUsers([b.createdById], { type: 'IMPORT_FAILED', title: `Import ${b.code} failed`, body: message.slice(0, 200), link: `/admin/imports/${b.id}` }, tx);
  });
}

// ── Rollback ───────────────────────────────────────────────────────

/**
 * Controlled rollback: leads inserted by the import are archived (never hard-deleted) unless they have
 * since been allocated; leads updated by the import are restored from the recorded `before` snapshot.
 */
export async function rollbackImport(ctx: AuthContext, id: string, reason: string) {
  return withPlatform(async (tx) => {
    const b = await tx.importBatch.findUnique({ where: { id } });
    if (!b) throw notFound('Import');
    if (b.status !== 'COMPLETED') throw new AppError('CONFLICT', 'Only completed imports can be rolled back');
    const insertedRows = await tx.importRow.findMany({ where: { importId: id, status: 'INSERTED' }, select: { leadId: true } });
    const leadIds = insertedRows.map((r) => r.leadId).filter(Boolean) as string[];
    const allocated = await tx.lead.count({ where: { id: { in: leadIds }, allocationStatus: { not: 'UNALLOCATED' } } });
    const archived = await tx.lead.updateMany({ where: { id: { in: leadIds }, allocationStatus: 'UNALLOCATED', archivedAt: null }, data: { archivedAt: new Date(), archivedReason: `Import ${b.code} rolled back` } });
    const updatedRows = await tx.importRow.findMany({ where: { importId: id, status: 'UPDATED', NOT: { before: { equals: Prisma.DbNull } } }, select: { leadId: true, before: true } });
    let restored = 0;
    for (const r of updatedRows) {
      if (!r.leadId || !r.before) continue;
      await tx.lead.update({ where: { id: r.leadId }, data: r.before as Prisma.LeadUpdateInput });
      restored++;
    }
    await tx.importBatch.update({ where: { id }, data: { status: 'ROLLED_BACK', rolledBackAt: new Date(), rolledBackById: ctx.user.id } });
    await audit(tx, ctx, { action: 'import.rolled_back', targetType: 'import', targetId: id, organizationId: null, reason, metadata: { archived: archived.count, keptAllocated: allocated, restored } });
    return { archived: archived.count, keptAllocated: allocated, restored };
  }, { timeout: 120_000 });
}

// ── Queries ────────────────────────────────────────────────────────

export async function listImports(params: { page: number; pageSize: number; status?: string; drafts?: boolean }) {
  return withPlatform(async (tx) => {
    const where: Prisma.ImportBatchWhereInput = params.drafts
      ? { confirmedAt: null, status: { in: ['UPLOADED', 'VALIDATING', 'PREVIEW_READY', 'FAILED'] }, fileDeletedAt: null }
      : params.status ? { status: params.status as ImportBatch['status'] } : {};
    const [total, rows] = await Promise.all([
      tx.importBatch.count({ where }),
      tx.importBatch.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (params.page - 1) * params.pageSize, take: params.pageSize }),
    ]);
    const users = await tx.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.createdById))] } }, select: { id: true, name: true } });
    const um = new Map(users.map((u) => [u.id, u.name]));
    return { total, rows: rows.map(({ mapping: _m, options: _o, headers: _h, detection: _d, sheets: _s, ...r }) => ({ ...r, columns: _h.length, createdBy: um.get(r.createdById) ?? '—' })) };
  });
}

export async function getImport(id: string) {
  return withPlatform(async (tx) => {
    const b = await tx.importBatch.findUnique({ where: { id } });
    if (!b) throw notFound('Import');
    const creator = await tx.user.findUnique({ where: { id: b.createdById }, select: { name: true, email: true } });
    const templates = await tx.importTemplate.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, mapping: true, options: true } });
    let sample: string[][] = [];
    let topRows: string[][] = [];
    if (b.storageKey && !b.fileDeletedAt && ['UPLOADED', 'PREVIEW_READY', 'FAILED'].includes(b.status) && !b.confirmedAt) {
      try {
        const a = await analyze(localPath(b.storageKey), b.fileType as FileKind, { sheetName: b.sheetName, headerRow: b.headerRow, delimiter: b.delimiter });
        sample = a.sample.slice(0, 12).map((r) => r.map((c) => c.slice(0, 120)));
        topRows = a.topRows.map((r) => r.map((c) => c.slice(0, 60)));
      } catch {
        sample = [];
      }
    }
    return { import: b, creator, templates, sample, topRows, problems: mappingReady(b.mapping as Record<string, string>, importOptionsSchema.parse(b.options)) };
  });
}

export async function listImportRows(id: string, params: { status?: ImportRowStatus; page: number; pageSize: number }) {
  return withPlatform(async (tx) => {
    const where: Prisma.ImportRowWhereInput = { importId: id, ...(params.status ? { status: params.status } : {}) };
    const [total, rows] = await Promise.all([
      tx.importRow.count({ where }),
      tx.importRow.findMany({ where, orderBy: { rowNumber: 'asc' }, skip: (params.page - 1) * params.pageSize, take: params.pageSize, select: { id: true, rowNumber: true, status: true, errors: true, normalized: true, matchLeadId: true, leadId: true } }),
    ]);
    // Contact values in previews are masked; the raw file is never echoed back to the browser.
    const { maskEmail, maskPhone } = await import('@/lib/mask');
    return {
      total,
      rows: rows.map((r) => {
        const n = (r.normalized ?? {}) as Partial<NormalizedRow>;
        return { ...r, normalized: { fullName: n.fullName, email: maskEmail(n.email), phone: maskPhone(n.phone), company: n.company, country: n.country, source: n.source, score: n.score } };
      }),
    };
  });
}

/** Failed/invalid row report for correction workflows. Formula-escaped; audited. */
export async function failedRowsCsv(ctx: AuthContext, id: string) {
  return withPlatform(async (tx) => {
    const b = await tx.importBatch.findUnique({ where: { id } });
    if (!b) throw notFound('Import');
    const rows = await tx.importRow.findMany({ where: { importId: id, status: { in: ['INVALID', 'FAILED', 'DUPLICATE', 'SKIPPED'] } }, orderBy: { rowNumber: 'asc' }, take: 200_000 });
    const headers = b.headers;
    const csv = toCsv([
      ['row_number', 'status', 'errors', ...headers],
      ...rows.map((r) => [r.rowNumber, r.status, r.errors.join(' | '), ...headers.map((h) => (r.raw as Record<string, string>)[h] ?? '')]),
    ]);
    await audit(tx, ctx, { action: 'import.failed_rows.downloaded', targetType: 'import', targetId: id, organizationId: null, metadata: { rows: rows.length } });
    return { csv, fileName: `${b.code}-rejected-rows.csv` };
  });
}

/** Maintenance: delete uploaded files and raw row data past their retention windows. */
export async function purgeImportData() {
  const { fileRetentionDays, rowDataRetentionDays } = await getSetting('imports.policy');
  const fileCutoff = new Date(Date.now() - fileRetentionDays * 86400_000);
  const rowCutoff = new Date(Date.now() - rowDataRetentionDays * 86400_000);
  const stale = await withPlatform((tx) =>
    tx.importBatch.findMany({
      where: {
        fileDeletedAt: null, storageKey: { not: null },
        OR: [{ status: { in: ['COMPLETED', 'ROLLED_BACK', 'CANCELLED', 'FAILED'] }, updatedAt: { lt: fileCutoff } }, { status: 'UPLOADED', createdAt: { lt: new Date(Date.now() - 86400_000) } }],
      },
      select: { id: true, storageKey: true },
    }),
  );
  for (const s of stale) {
    await removeFile(s.storageKey!).catch(() => null);
    await withPlatform((tx) => tx.importBatch.update({ where: { id: s.id }, data: { fileDeletedAt: new Date() } }));
  }
  const purged = await withPlatform((tx) =>
    tx.$executeRaw`UPDATE import_rows SET raw = '{}'::jsonb FROM imports WHERE import_rows."importId" = imports.id AND imports."createdAt" < ${rowCutoff} AND import_rows.raw <> '{}'::jsonb`,
  );
  return { filesDeleted: stale.length, rowsPurged: purged };
}
