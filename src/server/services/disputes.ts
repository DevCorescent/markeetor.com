import type { DisputeStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import { DISPUTE_REASON_KEYS, disputeReasonLabel } from '@/lib/growth';
import { audit } from '../audit';
import type { AuthContext } from '../auth/context';
import { shortCode } from '../crypto';
import { withPlatform, withTenant } from '../db';
import { AppError, notFound } from '../errors';
import { getCreditSettings, grantCredits } from './credits';
import { visibleLead } from './crm';
import { notifyPermission, notifyUsers } from './notifications';
import { getGrowth } from './saved-searches';
import { emitWebhook } from './workspace-automation';

/**
 * Lead quality guarantee. A workspace reports a purchased lead within the guarantee window; the platform
 * team approves or rejects (some reasons can auto-approve). Approval refunds the price paid as credits —
 * credit-paid leads get their share of the credits back; invoiced leads get credits worth the price — and,
 * for contact problems, marks the master lead invalid so it is never sold again.
 */

const CONTACT_PROBLEMS = new Set(['WRONG_NUMBER', 'BOUNCED_EMAIL', 'WRONG_PERSON', 'CLOSED_BUSINESS']);

export const reportInput = z.object({ reason: z.enum(DISPUTE_REASON_KEYS), details: z.string().trim().max(1000).optional() });

/** What the workspace paid for one delivered lead: request item price and its share of the credits. */
async function purchaseOf(orgId: string, leadId: string) {
  return withPlatform(async (tx) => {
    const item = await tx.leadRequestItem.findFirst({ where: { organizationId: orgId, leadId, status: 'DELIVERED' }, orderBy: { id: 'desc' }, include: { request: true } });
    if (!item) return null;
    const r = item.request;
    let credits = 0;
    if (r.paymentMethod === 'CREDITS' && r.creditsCharged > 0 && !item.free) {
      const paid = await tx.leadRequestItem.findMany({ where: { requestId: r.id, status: 'DELIVERED', free: false }, select: { price: true } });
      const sum = paid.reduce((a, i) => a + Number(i.price), 0);
      credits = sum > 0 ? Math.round((r.creditsCharged * Number(item.price)) / sum) : 0;
    }
    return { requestId: r.id, code: r.code, free: item.free, price: item.free ? 0 : Number(item.price), credits, method: r.paymentMethod, billing: r.billingStatus };
  });
}

/** Whether (and until when) a delivered lead can be reported. */
export async function disputeEligibility(ctx: AuthContext, clientLeadId: string) {
  const g = await getGrowth();
  const cl = await withTenant(ctx.orgId!, (tx) => visibleLead(tx, ctx, clientLeadId));
  const existing = await withPlatform((tx) => tx.leadDispute.findUnique({ where: { clientLeadId } }));
  const p = await purchaseOf(ctx.orgId!, cl.leadId);
  const until = new Date(cl.createdAt.getTime() + g.guarantee.windowDays * 86400_000);
  const reason = !g.guarantee.enabled ? 'The lead quality guarantee is not available right now'
    : existing ? null
    : !p ? 'Only leads bought from the marketplace are covered'
    : p.free ? 'Free demo leads are not covered'
    : Date.now() > until.getTime() ? `The ${g.guarantee.windowDays}-day guarantee window has passed`
    : null;
  return { eligible: !reason && !existing, reason, until, windowDays: g.guarantee.windowDays, refundPct: g.guarantee.refundPct, dispute: existing ? serialize(existing) : null, reasons: DISPUTE_REASON_KEYS.map((k) => ({ key: k, label: disputeReasonLabel(k) })) };
}

const serialize = (d: Prisma.LeadDisputeGetPayload<object>) => ({ ...d, paidAmount: Number(d.paidAmount), reasonLabel: disputeReasonLabel(d.reason) });

export async function reportLead(ctx: AuthContext, clientLeadId: string, input: z.infer<typeof reportInput>) {
  const g = await getGrowth();
  const e = await disputeEligibility(ctx, clientLeadId);
  if (e.dispute) throw new AppError('CONFLICT', 'This lead has already been reported');
  if (!e.eligible) throw new AppError('PRECONDITION_FAILED', e.reason ?? 'This lead cannot be reported');
  const orgId = ctx.orgId!;
  const cl = await withTenant(orgId, (tx) => visibleLead(tx, ctx, clientLeadId));
  const p = (await purchaseOf(orgId, cl.leadId))!;
  const cs = await getCreditSettings();
  // Abuse guard: share of the workspace's paid deliveries (30 days) that has been reported.
  const since = new Date(Date.now() - 30 * 86400_000);
  const [reported, delivered] = await withPlatform((tx) => Promise.all([
    tx.leadDispute.count({ where: { organizationId: orgId, createdAt: { gte: since } } }),
    tx.leadRequestItem.count({ where: { organizationId: orgId, status: 'DELIVERED', free: false, request: { decidedAt: { gte: since } } } }),
  ]));
  if (delivered > 0 && ((reported + 1) / delivered) * 100 > g.guarantee.maxReportPct && reported >= 2) {
    throw new AppError('PRECONDITION_FAILED', `You can report up to ${g.guarantee.maxReportPct}% of the leads you bought in the last 30 days. Contact the platform team about larger quality issues.`);
  }
  const base = p.credits > 0 ? p.credits : Math.ceil(p.price / cs.creditValue);
  const refund = Math.round((base * g.guarantee.refundPct) / 100);
  const d = await withPlatform(async (tx) => {
    let code = shortCode('DSP');
    while (await tx.leadDispute.findUnique({ where: { code } })) code = shortCode('DSP');
    const created = await tx.leadDispute.create({
      data: { code, organizationId: orgId, clientLeadId, leadId: cl.leadId, leadRequestId: p.requestId, reportedById: ctx.user.id, reason: input.reason, details: input.details ?? null, paidAmount: p.price, paidCredits: p.credits, refundCredits: refund },
    });
    await audit(tx, ctx, { action: 'marketplace.dispute.reported', targetType: 'lead_dispute', targetId: created.id, metadata: { code, reason: input.reason, request: p.code, refund } });
    return created;
  });
  if (g.guarantee.autoApproveReasons.includes(input.reason)) {
    return decide(null, d.id, { approve: true, resolution: 'Approved automatically under the lead quality guarantee' });
  }
  await notifyPermission('marketplace.manage', null, { type: 'LEAD_DISPUTE', title: `${ctx.org?.name ?? 'A client'} reported a lead`, body: `${d.code} · ${disputeReasonLabel(input.reason)}`, link: '/admin/marketplace?tab=disputes' });
  return serialize(d);
}

export const decideInput = z.object({
  approve: z.boolean(),
  resolution: z.string().trim().min(3).max(500),
  /** Override the credits refunded on approval. */
  refundCredits: z.number().int().min(0).max(10_000_000).optional(),
});

async function decide(ctx: AuthContext | null, id: string, input: z.infer<typeof decideInput>) {
  const g = await getGrowth();
  const d = await withPlatform(async (tx) => {
    await tx.$queryRaw`SELECT id FROM lead_disputes WHERE id = ${id} FOR UPDATE`;
    const d = await tx.leadDispute.findUnique({ where: { id } });
    if (!d) throw notFound('Report');
    if (d.status !== 'OPEN') throw new AppError('CONFLICT', 'This report was already decided');
    const refund = input.approve ? (input.refundCredits ?? d.refundCredits) : 0;
    const u = await tx.leadDispute.update({ where: { id }, data: { status: input.approve ? 'APPROVED' : 'REJECTED', resolution: input.resolution, refundCredits: refund, autoDecided: !ctx, decidedById: ctx?.user.id ?? null, decidedAt: new Date() } });
    if (input.approve && refund > 0) await grantCredits(tx, d.organizationId, { type: 'REFUND', credits: refund, note: `${d.code} · ${disputeReasonLabel(d.reason)}`, actorId: ctx?.user.id ?? null, leadRequestId: d.leadRequestId });
    if (input.approve && g.guarantee.invalidateOnApproval && CONTACT_PROBLEMS.has(d.reason)) await tx.lead.update({ where: { id: d.leadId }, data: { quality: 'INVALID' } });
    if (ctx) await audit(tx, ctx, { action: `marketplace.dispute.${input.approve ? 'approved' : 'rejected'}`, targetType: 'lead_dispute', targetId: id, organizationId: d.organizationId, reason: input.resolution, metadata: { code: d.code, refund } });
    await notifyUsers([d.reportedById], {
      type: 'LEAD_DISPUTE', organizationId: d.organizationId,
      title: input.approve ? `Report ${d.code} approved${refund ? ` — ${refund.toLocaleString()} credits refunded` : ''}` : `Report ${d.code} was not approved`,
      body: input.resolution, link: `/app/leads/${d.clientLeadId}`,
    }, tx);
    return u;
  });
  await emitWebhook(d.organizationId, 'dispute.decided', { code: d.code, clientLeadId: d.clientLeadId, status: d.status, refundCredits: d.refundCredits, resolution: d.resolution }).catch(() => null);
  return serialize(d);
}

export const decideDispute = (ctx: AuthContext, id: string, input: z.infer<typeof decideInput>) => decide(ctx, id, input);

export async function listDisputes(ctx: AuthContext, params: { status?: string; page: number; pageSize: number }) {
  const platform = ctx.scope === 'PLATFORM';
  return withPlatform(async (tx) => {
    const where: Prisma.LeadDisputeWhereInput = { ...(platform ? {} : { organizationId: ctx.orgId! }), ...(params.status ? { status: params.status as DisputeStatus } : {}) };
    const [total, rows, open] = await Promise.all([
      tx.leadDispute.count({ where }),
      tx.leadDispute.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (params.page - 1) * params.pageSize, take: params.pageSize }),
      tx.leadDispute.count({ where: { ...(platform ? {} : { organizationId: ctx.orgId! }), status: 'OPEN' } }),
    ]);
    const users = await tx.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.reportedById))] } }, select: { id: true, name: true } });
    const orgs = platform ? await tx.organization.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.organizationId))] } }, select: { id: true, name: true } }) : [];
    const leads = platform ? await tx.lead.findMany({ where: { id: { in: rows.map((r) => r.leadId) } }, select: { id: true, fullName: true, company: true, email: true, phone: true } }) : [];
    const reqs = await tx.leadRequest.findMany({ where: { id: { in: rows.map((r) => r.leadRequestId).filter((x): x is string => Boolean(x)) } }, select: { id: true, code: true } });
    return {
      total, open,
      rows: rows.map((r) => ({
        ...serialize(r), reporter: users.find((u) => u.id === r.reportedById)?.name ?? null, request: reqs.find((x) => x.id === r.leadRequestId)?.code ?? null,
        ...(platform ? { organization: orgs.find((o) => o.id === r.organizationId)?.name ?? null, lead: leads.find((l) => l.id === r.leadId) ?? null } : {}),
      })),
    };
  });
}
