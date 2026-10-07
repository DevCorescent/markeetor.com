import { createHash, randomUUID } from 'node:crypto';
import { audit } from '../audit';
import { tenantOf, type AuthContext } from '../auth/context';
import { withTenant } from '../db';
import { AppError, notFound } from '../errors';
import { rateLimit } from '../ratelimit';
import { localPath, putBuffer } from '../storage';
import { ACTIVITY, recordActivity } from './activity';
import { visibleLead } from './crm';

const MAX_BYTES = 10 * 1024 * 1024;

/** Allowed types are identified by content signature, not by the client-provided MIME type or extension. */
function sniff(buf: Buffer): { mime: string; ext: string } | null {
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return { mime: 'application/pdf', ext: 'pdf' };
  if (buf[0] === 0x89 && buf.subarray(1, 4).toString('latin1') === 'PNG') return { mime: 'image/png', ext: 'png' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  // Plain text: no NUL bytes and valid UTF-8 in the first 8 KB.
  const head = buf.subarray(0, 8192);
  if (!head.includes(0)) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(head);
      return { mime: 'text/plain', ext: 'txt' };
    } catch {}
  }
  return null;
}

export async function uploadAttachment(ctx: AuthContext, clientLeadId: string, file: { name: string; buffer: Buffer }) {
  const org = tenantOf(ctx);
  if (file.buffer.length === 0) throw new AppError('VALIDATION_FAILED', 'The file is empty');
  if (file.buffer.length > MAX_BYTES) throw new AppError('PAYLOAD_TOO_LARGE', 'Attachments are limited to 10 MB');
  const kind = sniff(file.buffer);
  if (!kind) throw new AppError('UNSUPPORTED_MEDIA', 'Allowed types: PDF, PNG, JPEG, WebP, plain text');
  const lim = await rateLimit(`attach-upload:${ctx.user.id}`, 60, 3600);
  if (!lim.ok) throw new AppError('RATE_LIMITED', 'Upload limit reached. Try again later.');
  const key = `attachments/${org}/${randomUUID()}.${kind.ext}`;
  await putBuffer(key, file.buffer);
  return withTenant(org, async (tx) => {
    const lead = await visibleLead(tx, ctx, clientLeadId);
    const a = await tx.attachment.create({
      data: {
        organizationId: org, clientLeadId, uploadedById: ctx.user.id, fileName: file.name.replace(/[^\w.\- ()]/g, '_').slice(0, 180),
        mimeType: kind.mime, size: file.buffer.length, sha256: createHash('sha256').update(file.buffer).digest('hex'), storageKey: key,
      },
    });
    await recordActivity(tx, { organizationId: org, clientLeadId, leadId: lead.leadId, actorId: ctx.user.id, type: ACTIVITY.ATTACHMENT_ADDED, summary: `Attached ${a.fileName}` });
    await audit(tx, ctx, { action: 'crm.attachment.uploaded', targetType: 'attachment', targetId: a.id, metadata: { fileName: a.fileName, size: a.size, mime: a.mimeType } });
    return a;
  });
}

/**
 * Returns the file for inline viewing. Served with Content-Disposition: inline and a sandboxing CSP.
 * A determined user can still save what their browser displays — this is risk reduction, not prevention.
 */
export async function openAttachment(ctx: AuthContext, attachmentId: string) {
  const org = tenantOf(ctx);
  const lim = await rateLimit(`attach-view:${ctx.user.id}`, 120, 3600);
  if (!lim.ok) throw new AppError('RATE_LIMITED', 'Viewing limit reached for this hour.');
  return withTenant(org, async (tx) => {
    const a = await tx.attachment.findFirst({ where: { id: attachmentId, organizationId: org, deletedAt: null } });
    if (!a) throw notFound('Attachment');
    const lead = await visibleLead(tx, ctx, a.clientLeadId);
    await recordActivity(tx, { organizationId: org, clientLeadId: a.clientLeadId, leadId: lead.leadId, actorId: ctx.user.id, type: ACTIVITY.ATTACHMENT_VIEWED, summary: `Viewed ${a.fileName}` });
    await audit(tx, ctx, { action: 'crm.attachment.viewed', targetType: 'attachment', targetId: a.id });
    return { path: localPath(a.storageKey), mime: a.mimeType, fileName: a.fileName, size: a.size };
  });
}

export async function deleteAttachment(ctx: AuthContext, attachmentId: string) {
  const org = tenantOf(ctx);
  return withTenant(org, async (tx) => {
    const a = await tx.attachment.findFirst({ where: { id: attachmentId, organizationId: org, deletedAt: null } });
    if (!a) throw notFound('Attachment');
    await visibleLead(tx, ctx, a.clientLeadId);
    if (a.uploadedById !== ctx.user.id && !ctx.permissions.has('crm.leads.archive')) throw new AppError('FORBIDDEN', 'Only the uploader or an administrator can remove this attachment');
    await tx.attachment.update({ where: { id: a.id }, data: { deletedAt: new Date() } });
    await audit(tx, ctx, { action: 'crm.attachment.deleted', targetType: 'attachment', targetId: a.id });
  });
}
