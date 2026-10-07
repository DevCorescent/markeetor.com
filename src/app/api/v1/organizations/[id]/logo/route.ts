import { readFile } from 'node:fs/promises';
import { idParam, route } from '@/server/api';
import { audit } from '@/server/audit';
import { prisma, withPlatform } from '@/server/db';
import { AppError, notFound } from '@/server/errors';
import { localPath, putBuffer } from '@/server/storage';

const SIGS: [string, (b: Buffer) => boolean, string][] = [
  ['image/png', (b) => b[0] === 0x89 && b.subarray(1, 4).toString('latin1') === 'PNG', 'png'],
  ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8, 'jpg'],
  ['image/webp', (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP', 'webp'],
];

export const POST = route({ perm: 'orgs.update' }, async ({ ctx, req, params }) => {
  const id = idParam(params);
  const form = await req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) throw new AppError('VALIDATION_FAILED', 'Attach an image file');
  if (file.size > 1024 * 1024) throw new AppError('PAYLOAD_TOO_LARGE', 'Logos are limited to 1 MB');
  const buf = Buffer.from(await file.arrayBuffer());
  const sig = SIGS.find(([, test]) => test(buf));
  if (!sig) throw new AppError('UNSUPPORTED_MEDIA', 'Use a PNG, JPEG or WebP image (SVG is not accepted)');
  const key = `logos/${id}.${sig[2]}`;
  await putBuffer(key, buf);
  await withPlatform(async (tx) => {
    await tx.organization.update({ where: { id }, data: { logoKey: key } });
    await audit(tx, ctx, { action: 'org.logo.updated', targetType: 'organization', targetId: id, organizationId: id });
  });
  return { ok: true };
});

/** Logos are visible to platform staff and to members of that organization only. */
export const GET = route({ scope: 'ANY', selfService: true }, async ({ ctx, params }) => {
  const id = idParam(params);
  if (ctx.scope === 'ORGANIZATION' && ctx.orgId !== id) throw notFound('Logo');
  if (ctx.scope === 'PLATFORM' && !ctx.permissions.has('orgs.read')) throw notFound('Logo');
  const org = await prisma.organization.findUnique({ where: { id }, select: { logoKey: true } });
  if (!org?.logoKey) throw notFound('Logo');
  const buf = await readFile(localPath(org.logoKey));
  const mime = org.logoKey.endsWith('.png') ? 'image/png' : org.logoKey.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
  return new Response(buf, { headers: { 'content-type': mime, 'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff' } });
});
