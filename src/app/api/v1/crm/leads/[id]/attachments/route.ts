import { idParam, route } from '@/server/api';
import { AppError } from '@/server/errors';
import { orgSettings } from '@/server/services/organizations';
import { uploadAttachment } from '@/server/services/attachments';

export const POST = route({ scope: 'ORGANIZATION', perm: 'crm.attachments.upload' }, async ({ ctx, req, params }) => {
  if (!orgSettings(ctx.org?.settings).features.attachments) throw new AppError('FORBIDDEN', 'Attachments are not enabled for this workspace');
  if (Number(req.headers.get('content-length') ?? 0) > 11 * 1024 * 1024) throw new AppError('PAYLOAD_TOO_LARGE', 'Attachments are limited to 10 MB');
  const form = await req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) throw new AppError('VALIDATION_FAILED', 'Attach a file');
  const a = await uploadAttachment(ctx, idParam(params), { name: file.name, buffer: Buffer.from(await file.arrayBuffer()) });
  return { id: a.id, fileName: a.fileName, size: a.size, mimeType: a.mimeType };
});
