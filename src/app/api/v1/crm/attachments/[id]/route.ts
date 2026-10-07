import { readFile } from 'node:fs/promises';
import { idParam, route } from '@/server/api';
import { deleteAttachment, openAttachment } from '@/server/services/attachments';

/** Inline, sandboxed, non-cacheable viewing. No `attachment` disposition is ever issued for workspace files. */
export const GET = route({ scope: 'ORGANIZATION', perm: 'crm.attachments.view' }, async ({ ctx, params }) => {
  const f = await openAttachment(ctx, idParam(params));
  const buf = await readFile(f.path);
  return new Response(buf, {
    headers: {
      'content-type': f.mime,
      'content-disposition': `inline; filename="${encodeURIComponent(f.fileName)}"`,
      'cache-control': 'no-store, private',
      'x-content-type-options': 'nosniff',
      // Browsers refuse to render PDFs inside sandboxed documents, so PDFs get a restrictive non-sandbox policy.
      'content-security-policy': f.mime === 'application/pdf' ? "default-src 'none'; object-src 'self'; frame-ancestors 'self'" : "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'",
      'cross-origin-resource-policy': 'same-origin',
    },
  });
});

export const DELETE = route({ scope: 'ORGANIZATION', perm: ['crm.attachments.upload', 'crm.leads.archive'] }, async ({ ctx, params }) => {
  await deleteAttachment(ctx, idParam(params));
  return { ok: true };
});
