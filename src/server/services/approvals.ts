import type { Prisma } from '@prisma/client';
import { audit } from '../audit';
import type { AuthContext } from '../auth/context';
import { withPlatform, type Tx } from '../db';
import { AppError, forbidden, notFound } from '../errors';
import { notifyPermission } from './notifications';

export type ApprovalType = 'INVITE_PRIVILEGED' | 'ROLE_GRANT_PRIVILEGED';

/** Creates a pending approval for a highly privileged operation. A *different* approver must decide it. */
export async function createApproval(tx: Tx, ctx: AuthContext, input: { type: ApprovalType; summary: string; payload: Record<string, unknown> }) {
  const row = await tx.approvalRequest.create({
    data: {
      type: input.type,
      summary: input.summary,
      payload: input.payload as Prisma.InputJsonValue,
      requestedById: ctx.user.id,
      expiresAt: new Date(Date.now() + 72 * 3600_000),
    },
  });
  await audit(tx, ctx, { action: 'approval.requested', targetType: 'approval', targetId: row.id, organizationId: null, after: { type: input.type, summary: input.summary } });
  await notifyPermission('approvals.decide', null, {
    type: 'APPROVAL_REQUESTED', title: `Approval needed: ${input.summary}`, link: '/admin/approvals', dedupeKey: `approval:${row.id}`,
  }, tx);
  return row;
}

export async function listApprovals(status?: 'PENDING' | 'APPROVED' | 'REJECTED') {
  return withPlatform(async (tx) => {
    await tx.approvalRequest.updateMany({ where: { status: 'PENDING', expiresAt: { lt: new Date() } }, data: { status: 'EXPIRED' } });
    const rows = await tx.approvalRequest.findMany({ where: status ? { status } : {}, orderBy: { createdAt: 'desc' }, take: 100 });
    const users = await tx.user.findMany({
      where: { id: { in: [...new Set(rows.flatMap((r) => [r.requestedById, r.decidedById].filter(Boolean) as string[]))] } },
      select: { id: true, name: true, email: true },
    });
    const um = new Map(users.map((u) => [u.id, u]));
    return rows.map((r) => ({ ...r, requestedBy: um.get(r.requestedById) ?? null, decidedBy: r.decidedById ? (um.get(r.decidedById) ?? null) : null }));
  });
}

export async function decideApproval(ctx: AuthContext, id: string, approve: boolean, note: string) {
  return withPlatform(async (tx) => {
    const row = await tx.approvalRequest.findUnique({ where: { id } });
    if (!row) throw notFound('Approval');
    if (row.status !== 'PENDING') throw new AppError('CONFLICT', `This request is already ${row.status.toLowerCase()}`);
    if (row.expiresAt < new Date()) throw new AppError('CONFLICT', 'This request has expired');
    if (row.requestedById === ctx.user.id) throw forbidden('You cannot approve your own request');

    let result: Record<string, unknown> = {};
    if (approve) {
      const p = row.payload as Record<string, string>;
      if (row.type === 'INVITE_PRIVILEGED') {
        const { createInvitation } = await import('./users');
        const res = await createInvitation(tx, ctx, { email: p.email, name: p.name, roleId: p.roleId, organizationId: p.organizationId ?? null }, { skipApproval: true });
        result = { invitationId: res.invitationId };
      } else if (row.type === 'ROLE_GRANT_PRIVILEGED') {
        const role = await tx.role.findUniqueOrThrow({ where: { id: p.roleId } });
        if (role.rank > ctx.role.rank) throw forbidden('You cannot approve a role more privileged than your own');
        const { applyRoleChange } = await import('./users');
        await applyRoleChange(tx, ctx, p.userId, p.roleId, `${p.reason ?? ''} (approved request ${row.id})`.trim());
      }
    }
    await tx.approvalRequest.update({
      where: { id },
      data: { status: approve ? 'APPROVED' : 'REJECTED', decidedById: ctx.user.id, decidedAt: new Date(), decisionNote: note },
    });
    await audit(tx, ctx, { action: approve ? 'approval.approved' : 'approval.rejected', targetType: 'approval', targetId: id, organizationId: null, reason: note, metadata: { type: row.type, ...result } });
    return { status: approve ? 'APPROVED' : 'REJECTED', ...result };
  });
}
