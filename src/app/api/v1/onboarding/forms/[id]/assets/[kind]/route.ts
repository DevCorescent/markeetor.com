import { route } from '@/server/api';
import { AppError } from '@/server/errors';
import { removeFormAsset, uploadFormAsset } from '@/server/services/onboarding';

const kindOf = (k: string) => {
  if (k !== 'logo' && k !== 'cover') throw new AppError('NOT_FOUND', 'Unknown asset');
  return k;
};
export const POST = route({ perm: 'onboarding.manage', rate: { bucket: 'form-asset', limit: 60, windowSec: 3600 } }, async ({ ctx, req, params }) => {
  if (!(req.headers.get('content-type') ?? '').includes('multipart/form-data')) throw new AppError('UNSUPPORTED_MEDIA', 'Upload the file as multipart/form-data');
  const file = (await req.formData()).get('file');
  if (!(file instanceof File)) throw new AppError('VALIDATION_FAILED', 'Attach an image');
  return { url: await uploadFormAsset(ctx, params.id, kindOf(params.kind), Buffer.from(await file.arrayBuffer())) };
});
export const DELETE = route({ perm: 'onboarding.manage' }, async ({ params }) => {
  await removeFormAsset(params.id, kindOf(params.kind));
  return { ok: true };
});
