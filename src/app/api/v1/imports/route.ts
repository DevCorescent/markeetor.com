import { z } from 'zod';
import { paginationQuery, route } from '@/server/api';
import { AppError } from '@/server/errors';
import { configureImport, createImport, importOptionsSchema, listImports, mappingReady } from '@/server/services/imports';

export const GET = route(
  { perm: 'imports.read', apiKey: true, query: paginationQuery.extend({ status: z.string().max(30).optional(), drafts: z.enum(['1', '0']).optional() }) },
  async ({ query }) => listImports({ ...query, drafts: query.drafts === '1' }),
);

/**
 * Upload. With form field `auto=1` the detected mapping is applied immediately and the import runs
 * hands-off once validation passes (falls back to the review wizard if detection is incomplete).
 */
export const POST = route({ perm: 'imports.create', rate: { bucket: 'import-upload', limit: 30, windowSec: 3600 } }, async ({ ctx, req }) => {
  const maxMb = Number(process.env.MAX_UPLOAD_MB ?? 25);
  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > (maxMb + 1) * 1024 * 1024) throw new AppError('PAYLOAD_TOO_LARGE', `Files are limited to ${maxMb} MB`);
  if (!(req.headers.get('content-type') ?? '').includes('multipart/form-data')) throw new AppError('UNSUPPORTED_MEDIA', 'Upload the file as multipart/form-data');
  const form = await req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) throw new AppError('VALIDATION_FAILED', 'Attach a CSV or XLSX file');
  const res = await createImport(ctx, { name: file.name, size: file.size, buffer: Buffer.from(await file.arrayBuffer()) });
  let auto: { started: boolean; problems: string[] } | null = null;
  if (form.get('auto') === '1') {
    const options = importOptionsSchema.parse({ ...(res.import.options as object), autoConfirm: true });
    const problems = mappingReady(res.import.mapping as Record<string, string>, options);
    if (!problems.length) {
      await configureImport(ctx, res.import.id, { mapping: res.import.mapping as Record<string, string>, options, tags: [] });
      auto = { started: true, problems: [] };
    } else auto = { started: false, problems };
  }
  return { ...res, auto };
});
