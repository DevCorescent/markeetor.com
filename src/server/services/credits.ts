import { Prisma, type CreditEntryType, type CreditRequest, type CreditRequestStatus } from '@prisma/client';
import { z } from 'zod';
import { creditSettingsSchema, DEFAULT_CREDIT_SETTINGS, fmtCredits, priceCreditPurchase, type CreditSettings } from '@/lib/credits';
import { audit } from '../audit';
import type { AuthContext } from '../auth/context';
import { shortCode } from '../crypto';
import { withPlatform, type Tx } from '../db';
import { AppError, notFound } from '../errors';
import { getSetting, invalidateSetting } from '../settings';
import { notifyPermission, notifyUsers } from './notifications';

/**
 * Lead credits. Every change to a balance is an entry in the append-only ledger (`credit_entries`);
 * `credit_wallets.balance` is its running total, updated in the same transaction under a row lock.
 * Positive entries are lots: spending consumes the lots that expire first, so expiry is exact per purchase.
 */

// ── Settings ───────────────────────────────────────────────────────

export async function getCreditSettings(): Promise<CreditSettings> {
  const raw = await getSetting('credits');
  const parsed = creditSettingsSchema.safeParse({ ...DEFAULT_CREDIT_SETTINGS, ...(raw as object) });
  return parsed.success ? parsed.data : DEFAULT_CREDIT_SETTINGS;
}

export async function saveCreditSettings(ctx: AuthContext, input: CreditSettings) {
  const value = creditSettingsSchema.parse(input);
  if (value.custom.minCredits > value.custom.maxCredits) throw new AppError('VALIDATION_FAILED', 'Custom minimum must not exceed the maximum');
  if (new Set(value.packages.map((p) => p.id)).size !== value.packages.length) throw new AppError('VALIDATION_FAILED', 'Each credit pack needs a unique id');
  const before = await getCreditSettings();
  await withPlatform(async (tx) => {
    await tx.platformSetting.upsert({ where: { key: 'credits' }, create: { key: 'credits', value: value as unknown as Prisma.InputJsonValue, updatedById: ctx.user.id }, update: { value: value as unknown as Prisma.InputJsonValue, updatedById: ctx.user.id } });
    await audit(tx, ctx, { action: 'settings.credits.updated', targetType: 'platform_setting', targetId: 'credits', organizationId: null, before, after: value });
  });
  invalidateSetting('credits');
  return value;
}

// ── Ledger primitives (call inside a platform transaction) ─────────

/** Locks (creating if needed) a workspace's wallet. New wallets receive the welcome credits. */
async function lockWallet(tx: Tx, orgId: string, s: CreditSettings) {
  await tx.$executeRaw`INSERT INTO credit_wallets ("organizationId", balance, "lifetimeIn", "lifetimeSpent", "createdAt", "updatedAt") VALUES (${orgId}, 0, 0, 0, now(), now()) ON CONFLICT ("organizationId") DO NOTHING`;
  const [w] = await tx.$queryRaw<{ balance: number; lifetimeIn: number; lifetimeSpent: number; lowBalanceNotifiedAt: Date | null; createdAt: Date }[]>`
    SELECT balance, "lifetimeIn", "lifetimeSpent", "lowBalanceNotifiedAt", "createdAt" FROM credit_wallets WHERE "organizationId" = ${orgId} FOR UPDATE`;
  if (s.welcomeCredits > 0 && w.lifetimeIn === 0 && !(await tx.creditEntry.findFirst({ where: { organizationId: orgId, type: 'WELCOME' }, select: { id: true } }))) {
    await addLot(tx, orgId, { type: 'WELCOME', credits: s.welcomeCredits, note: 'Welcome credits', expiresAt: expiry(s) }, w.balance);
    return { ...w, balance: w.balance + s.welcomeCredits, lifetimeIn: s.welcomeCredits };
  }
  await expireLots(tx, orgId, w.balance);
  const fresh = await tx.creditWallet.findUniqueOrThrow({ where: { organizationId: orgId } });
  return fresh;
}

const expiry = (s: CreditSettings) => (s.expiryDays ? new Date(Date.now() + s.expiryDays * 86400_000) : null);

async function addLot(tx: Tx, orgId: string, e: { type: CreditEntryType; credits: number; note?: string | null; expiresAt?: Date | null; leadRequestId?: string | null; creditRequestId?: string | null; actorId?: string | null }, balance: number) {
  const after = balance + e.credits;
  await tx.creditWallet.update({ where: { organizationId: orgId }, data: { balance: after, ...(e.type === 'REFUND' ? { lifetimeSpent: { decrement: e.credits } } : { lifetimeIn: { increment: e.credits } }), ...(after > 0 ? { lowBalanceNotifiedAt: null } : {}) } });
  return tx.creditEntry.create({ data: { organizationId: orgId, type: e.type, credits: e.credits, balanceAfter: after, remaining: e.credits, expiresAt: e.expiresAt ?? null, note: e.note ?? null, leadRequestId: e.leadRequestId ?? null, creditRequestId: e.creditRequestId ?? null, actorId: e.actorId ?? null } });
}

/** Takes credits from the lots that expire first (never-expiring last, oldest first). */
async function consume(tx: Tx, orgId: string, credits: number) {
  const lots = await tx.creditEntry.findMany({ where: { organizationId: orgId, remaining: { gt: 0 } }, orderBy: [{ expiresAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }], select: { id: true, remaining: true } });
  const allocations: { id: string; credits: number }[] = [];
  let left = credits;
  for (const lot of lots) {
    if (left <= 0) break;
    const take = Math.min(left, lot.remaining!);
    await tx.creditEntry.update({ where: { id: lot.id }, data: { remaining: { decrement: take } } });
    allocations.push({ id: lot.id, credits: take });
    left -= take;
  }
  if (left > 0) throw new AppError('CONFLICT', 'Credit ledger is out of balance');
  return allocations;
}

/** Turns lots past their expiry date into EXPIRY entries. */
async function expireLots(tx: Tx, orgId: string, balance: number) {
  const lots = await tx.creditEntry.findMany({ where: { organizationId: orgId, remaining: { gt: 0 }, expiresAt: { lte: new Date() } }, select: { id: true, remaining: true } });
  let b = balance;
  for (const lot of lots) {
    await tx.creditEntry.update({ where: { id: lot.id }, data: { remaining: 0 } });
    b -= lot.remaining!;
    await tx.creditEntry.create({ data: { organizationId: orgId, type: 'EXPIRY', credits: -lot.remaining!, balanceAfter: b, note: 'Credits expired', allocations: [{ id: lot.id, credits: lot.remaining! }] } });
  }
  if (lots.length) await tx.creditWallet.update({ where: { organizationId: orgId }, data: { balance: b } });
  return b;
}

/** Spends credits on a lead request. Throws when the balance is too low. */
export async function spendCredits(tx: Tx, orgId: string, credits: number, opts: { leadRequestId: string; note: string; actorId?: string | null }) {
  const s = await getCreditSettings();
  const w = await lockWallet(tx, orgId, s);
  if (credits <= 0) return w.balance;
  if (w.balance < credits) throw new AppError('PRECONDITION_FAILED', `Not enough ${s.label.toLowerCase()}: this request needs ${fmtCredits(credits)} and your balance is ${fmtCredits(w.balance)}.`, { needed: credits, balance: w.balance });
  const allocations = await consume(tx, orgId, credits);
  const after = w.balance - credits;
  await tx.creditWallet.update({ where: { organizationId: orgId }, data: { balance: after, lifetimeSpent: { increment: credits } } });
  await tx.creditEntry.create({ data: { organizationId: orgId, type: 'SPEND', credits: -credits, balanceAfter: after, leadRequestId: opts.leadRequestId, note: opts.note, allocations, actorId: opts.actorId ?? null } });
  await maybeLowBalance(tx, orgId, after, w.lowBalanceNotifiedAt, s);
  return after;
}

/** Charges credits for a marketing action (message, AI draft). Returns false when the balance is too low. */
export async function chargeCredits(tx: Tx, orgId: string, credits: number, note: string, actorId?: string | null) {
  if (credits <= 0) return true;
  const s = await getCreditSettings();
  const w = await lockWallet(tx, orgId, s);
  if (w.balance < credits) return false;
  const allocations = await consume(tx, orgId, credits);
  const after = w.balance - credits;
  await tx.creditWallet.update({ where: { organizationId: orgId }, data: { balance: after, lifetimeSpent: { increment: credits } } });
  await tx.creditEntry.create({ data: { organizationId: orgId, type: 'SPEND', credits: -credits, balanceAfter: after, note: note.slice(0, 300), allocations, actorId: actorId ?? null } });
  await maybeLowBalance(tx, orgId, after, w.lowBalanceNotifiedAt, s);
  return true;
}

/** Returns credits for leads that were not delivered. They keep the latest expiry of the lots they came from. */
export async function refundCredits(tx: Tx, orgId: string, credits: number, opts: { leadRequestId: string; note: string; actorId?: string | null }) {
  if (credits <= 0) return;
  const s = await getCreditSettings();
  const w = await lockWallet(tx, orgId, s);
  const spends = await tx.creditEntry.findMany({ where: { organizationId: orgId, leadRequestId: opts.leadRequestId, type: 'SPEND' }, select: { allocations: true } });
  const lotIds = spends.flatMap((x) => ((x.allocations ?? []) as { id: string }[]).map((a) => a.id));
  const lots = lotIds.length ? await tx.creditEntry.findMany({ where: { id: { in: lotIds } }, select: { expiresAt: true } }) : [];
  const expiresAt = lots.length && lots.every((l) => l.expiresAt) ? new Date(Math.max(...lots.map((l) => l.expiresAt!.getTime()))) : null;
  await addLot(tx, orgId, { type: 'REFUND', credits, note: opts.note, leadRequestId: opts.leadRequestId, actorId: opts.actorId, expiresAt }, w.balance);
}

async function maybeLowBalance(tx: Tx, orgId: string, balance: number, notifiedAt: Date | null, s: CreditSettings) {
  if (!s.lowBalanceThreshold || balance >= s.lowBalanceThreshold || notifiedAt) return;
  await tx.creditWallet.update({ where: { organizationId: orgId }, data: { lowBalanceNotifiedAt: new Date() } });
  await notifyPermission('crm.marketplace.request', orgId, { type: 'CREDITS_LOW', title: `Your ${s.label.toLowerCase()} balance is low`, body: `${fmtCredits(balance)} left. Buy more to keep requesting leads instantly.`, link: '/app/billing?tab=credits' }, tx);
}

/** Adds credits outside a purchase (guarantee refunds, referral rewards). */
export async function grantCredits(tx: Tx, orgId: string, e: { type: 'GRANT' | 'REFUND' | 'BONUS'; credits: number; note: string; actorId?: string | null; leadRequestId?: string | null }) {
  if (e.credits <= 0) return null;
  const s = await getCreditSettings();
  const w = await lockWallet(tx, orgId, s);
  return addLot(tx, orgId, { ...e, expiresAt: e.type === 'REFUND' ? null : expiry(s) }, w.balance);
}

export async function walletBalance(tx: Tx, orgId: string) {
  const s = await getCreditSettings();
  return (await lockWallet(tx, orgId, s)).balance;
}

// ── Platform-team adjustments ──────────────────────────────────────

export const adjustInput = z.object({
  organizationId: z.string().min(1).max(64),
  credits: z.number().int().min(-10_000_000).max(10_000_000).refine((n) => n !== 0, 'Enter a non-zero amount'),
  reason: z.string().trim().min(3).max(500),
  /** Positive grants only: override the default expiry (days; null = never). */
  expiryDays: z.number().int().min(1).max(3650).nullable().optional(),
});

export async function adjustCredits(ctx: AuthContext, input: z.infer<typeof adjustInput>) {
  const s = await getCreditSettings();
  return withPlatform(async (tx) => {
    const org = await tx.organization.findUnique({ where: { id: input.organizationId }, select: { id: true, name: true } });
    if (!org) throw notFound('Workspace');
    const w = await lockWallet(tx, org.id, s);
    let entry;
    if (input.credits > 0) {
      const expiresAt = input.expiryDays === undefined ? expiry(s) : input.expiryDays ? new Date(Date.now() + input.expiryDays * 86400_000) : null;
      entry = await addLot(tx, org.id, { type: 'GRANT', credits: input.credits, note: input.reason, actorId: ctx.user.id, expiresAt }, w.balance);
    } else {
      const take = -input.credits;
      if (take > w.balance) throw new AppError('VALIDATION_FAILED', `The balance is only ${fmtCredits(w.balance)}`);
      const allocations = await consume(tx, org.id, take);
      const after = w.balance - take;
      await tx.creditWallet.update({ where: { organizationId: org.id }, data: { balance: after } });
      entry = await tx.creditEntry.create({ data: { organizationId: org.id, type: 'ADJUSTMENT', credits: -take, balanceAfter: after, note: input.reason, allocations, actorId: ctx.user.id } });
    }
    await audit(tx, ctx, { action: 'credits.adjusted', targetType: 'credit_wallet', targetId: org.id, organizationId: org.id, before: { balance: w.balance }, after: { balance: entry.balanceAfter }, reason: input.reason, metadata: { credits: input.credits } });
    await notifyPermission('crm.billing.view', org.id, {
      type: 'CREDITS_UPDATED', title: input.credits > 0 ? `${fmtCredits(input.credits)} ${s.label.toLowerCase()} added to your workspace` : `${fmtCredits(-input.credits)} ${s.label.toLowerCase()} removed from your workspace`,
      body: input.reason, link: '/app/billing?tab=credits',
    }, tx);
    return { balance: entry.balanceAfter, entryId: entry.id };
  });
}

// ── Credit purchase requests ───────────────────────────────────────

export const creditRequestInput = z.object({
  packageId: z.string().max(40).optional(),
  credits: z.number().int().min(1).max(10_000_000).optional(),
  note: z.string().trim().max(500).optional(),
}).refine((x) => Boolean(x.packageId) !== Boolean(x.credits), 'Choose a credit pack or enter an amount');

function assertEnabled(s: CreditSettings) {
  if (!s.enabled) throw new AppError('FORBIDDEN', 'Credits are not available right now');
}

export async function quoteCreditPurchase(ctx: AuthContext, input: { packageId?: string; credits?: number }) {
  const s = await getCreditSettings();
  assertEnabled(s);
  const q = priceCreditPurchase(input, s, ctx.orgId);
  if ('error' in q) throw new AppError('VALIDATION_FAILED', q.error);
  return q;
}

export async function createCreditRequest(ctx: AuthContext, input: z.infer<typeof creditRequestInput>) {
  const s = await getCreditSettings();
  assertEnabled(s);
  const orgId = ctx.orgId!;
  const q = priceCreditPurchase(input, s, orgId);
  if ('error' in q) throw new AppError('VALIDATION_FAILED', q.error);
  const { currency } = await getSetting('pricing');
  const open = await withPlatform((tx) => tx.creditRequest.count({ where: { organizationId: orgId, status: { in: ['PENDING', 'AWAITING_PAYMENT'] } } }));
  if (open >= 5) throw new AppError('CONFLICT', 'You already have 5 open credit requests. Complete or cancel one first.');
  const r = await withPlatform(async (tx) => {
    let code = shortCode('CR');
    while (await tx.creditRequest.findUnique({ where: { code } })) code = shortCode('CR');
    const created = await tx.creditRequest.create({
      data: {
        code, organizationId: orgId, requestedById: ctx.user.id, packageId: q.packageId, packageName: q.packageName, credits: q.credits, bonusCredits: q.bonusCredits,
        currency, amount: q.amountCents / 100, tax: q.taxCents / 100, total: q.totalCents / 100, clientNote: input.note ?? null,
        paymentDetails: s.paymentInstructions || null,
      },
    });
    await audit(tx, ctx, { action: 'credits.request.created', targetType: 'credit_request', targetId: created.id, metadata: { code, credits: q.credits, bonus: q.bonusCredits, total: q.totalCents / 100, currency } });
    return created;
  });
  await notifyPermission('marketplace.manage', null, {
    type: 'CREDIT_REQUEST', title: `${ctx.org?.name ?? 'A client'} requested ${fmtCredits(q.credits + q.bonusCredits)} ${s.label.toLowerCase()}`,
    body: `${r.code} · ${currency} ${(q.totalCents / 100).toFixed(2)}${r.packageName ? ` · ${r.packageName}` : ''}`, link: '/admin/marketplace?tab=credits',
  });
  return serializeRequest(r);
}

const serializeRequest = (r: CreditRequest & { organization?: { name: string } | null; requester?: { name: string; email: string } | null; decidedBy?: { name: string } | null }) => ({
  ...r, amount: Number(r.amount), tax: Number(r.tax), total: Number(r.total),
});

async function getRequest(tx: Tx, id: string) {
  const r = await tx.creditRequest.findUnique({ where: { id } });
  if (!r) throw notFound('Credit request');
  return r;
}
const OPEN: CreditRequestStatus[] = ['PENDING', 'AWAITING_PAYMENT'];

export async function cancelCreditRequest(ctx: AuthContext, id: string) {
  return withPlatform(async (tx) => {
    const r = await getRequest(tx, id);
    if (r.organizationId !== ctx.orgId) throw notFound('Credit request');
    if (!OPEN.includes(r.status)) throw new AppError('CONFLICT', 'Only open requests can be cancelled');
    const u = await tx.creditRequest.update({ where: { id }, data: { status: 'CANCELLED', decidedAt: new Date() } });
    await audit(tx, ctx, { action: 'credits.request.cancelled', targetType: 'credit_request', targetId: id });
    return serializeRequest(u);
  });
}

/** The client tells the platform team how they paid (UTR / transaction id). */
export async function submitPaymentReference(ctx: AuthContext, id: string, reference: string) {
  const r = await withPlatform(async (tx) => {
    const r = await getRequest(tx, id);
    if (r.organizationId !== ctx.orgId) throw notFound('Credit request');
    if (!OPEN.includes(r.status)) throw new AppError('CONFLICT', 'This request is already closed');
    const u = await tx.creditRequest.update({ where: { id }, data: { clientReference: reference } });
    await audit(tx, ctx, { action: 'credits.request.paid_by_client', targetType: 'credit_request', targetId: id, metadata: { reference } });
    return u;
  });
  await notifyPermission('marketplace.manage', null, { type: 'CREDIT_REQUEST', title: `Payment reported for ${r.code}`, body: `${ctx.org?.name ?? 'Client'} · reference ${reference}`, link: '/admin/marketplace?tab=credits' });
  return serializeRequest(r);
}

export async function sendPaymentDetails(ctx: AuthContext, id: string, details: string) {
  return withPlatform(async (tx) => {
    const r = await getRequest(tx, id);
    if (!OPEN.includes(r.status)) throw new AppError('CONFLICT', 'This request is already closed');
    const u = await tx.creditRequest.update({ where: { id }, data: { status: 'AWAITING_PAYMENT', paymentDetails: details } });
    await audit(tx, ctx, { action: 'credits.request.awaiting_payment', targetType: 'credit_request', targetId: id, organizationId: r.organizationId });
    await notifyUsers([r.requestedById], { type: 'CREDIT_REQUEST', organizationId: r.organizationId, title: `Payment details for ${r.code}`, body: `Pay ${r.currency} ${Number(r.total).toFixed(2)} to receive your credits.`, link: '/app/billing?tab=credits' }, tx);
    return serializeRequest(u);
  });
}

export const completeInput = z.object({
  paymentMethod: z.string().trim().min(1).max(40),
  paymentReference: z.string().trim().max(120).optional(),
  /** Amount actually received (defaults to the request total). */
  amountReceived: z.number().min(0).max(100_000_000).optional(),
  note: z.string().trim().max(500).optional(),
  /** Extra goodwill credits on top of the request. */
  extraCredits: z.number().int().min(0).max(10_000_000).optional(),
});

/** Payment received: adds the purchased credits (and bonus) to the workspace and issues a receipt number. */
export async function completeCreditRequest(ctx: AuthContext, id: string, input: z.infer<typeof completeInput>) {
  const s = await getCreditSettings();
  return withPlatform(async (tx) => {
    // Lock the request so a double click can never add credits twice.
    await tx.$queryRaw`SELECT id FROM credit_requests WHERE id = ${id} FOR UPDATE`;
    const r = await getRequest(tx, id);
    if (!OPEN.includes(r.status)) throw new AppError('CONFLICT', r.status === 'COMPLETED' ? 'Credits were already added for this request' : 'This request is closed');
    const w = await lockWallet(tx, r.organizationId, s);
    const expiresAt = expiry(s);
    const bought = await addLot(tx, r.organizationId, { type: 'PURCHASE', credits: r.credits, note: `${r.code}${r.packageName ? ` · ${r.packageName}` : ''}`, creditRequestId: r.id, actorId: ctx.user.id, expiresAt }, w.balance);
    let balance = bought.balanceAfter;
    const bonus = r.bonusCredits + (input.extraCredits ?? 0);
    if (bonus > 0) balance = (await addLot(tx, r.organizationId, { type: 'BONUS', credits: bonus, note: `${r.code} bonus`, creditRequestId: r.id, actorId: ctx.user.id, expiresAt }, balance)).balanceAfter;
    let invoiceNumber = shortCode('CRI', 8);
    while (await tx.creditRequest.findUnique({ where: { invoiceNumber } })) invoiceNumber = shortCode('CRI', 8);
    const u = await tx.creditRequest.update({
      where: { id },
      data: {
        status: 'COMPLETED', paymentMethod: input.paymentMethod, paymentReference: input.paymentReference ?? r.clientReference ?? null, paidAt: new Date(), invoiceNumber,
        bonusCredits: bonus, adminNote: input.note ?? r.adminNote, decidedById: ctx.user.id, decidedAt: new Date(),
        ...(input.amountReceived != null && input.amountReceived !== Number(r.total) ? { adminNote: [input.note, `Received ${r.currency} ${input.amountReceived.toFixed(2)}`].filter(Boolean).join(' · ') } : {}),
      },
    });
    await audit(tx, ctx, { action: 'credits.request.completed', targetType: 'credit_request', targetId: id, organizationId: r.organizationId, metadata: { code: r.code, credits: r.credits, bonus, method: input.paymentMethod, reference: u.paymentReference, total: Number(r.total), received: input.amountReceived ?? Number(r.total) } });
    await notifyUsers([r.requestedById], {
      type: 'CREDITS_ADDED', organizationId: r.organizationId, title: `${fmtCredits(r.credits + bonus)} ${s.label.toLowerCase()} added to your workspace`,
      body: `${r.code} · receipt ${invoiceNumber} · new balance ${fmtCredits(balance)}`, link: '/app/billing?tab=credits',
    }, tx);
    return { ...serializeRequest(u), balance };
  }).then(async (out) => {
    const { rewardReferral } = await import('./client-tools');
    await rewardReferral(out.organizationId).catch(() => null);
    const { issueInvoice } = await import('./finance');
    await issueInvoice('CREDIT_PURCHASE', out.id);
    return out;
  });
}

export async function rejectCreditRequest(ctx: AuthContext, id: string, reason: string) {
  return withPlatform(async (tx) => {
    const r = await getRequest(tx, id);
    if (!OPEN.includes(r.status)) throw new AppError('CONFLICT', 'Only open requests can be declined');
    const u = await tx.creditRequest.update({ where: { id }, data: { status: 'REJECTED', adminNote: reason, decidedById: ctx.user.id, decidedAt: new Date() } });
    await audit(tx, ctx, { action: 'credits.request.rejected', targetType: 'credit_request', targetId: id, organizationId: r.organizationId, reason });
    await notifyUsers([r.requestedById], { type: 'CREDIT_REQUEST', organizationId: r.organizationId, title: `Credit request ${r.code} was declined`, body: reason, link: '/app/billing?tab=credits' }, tx);
    return serializeRequest(u);
  });
}

// ── Reading ────────────────────────────────────────────────────────

export async function listCreditRequests(ctx: AuthContext, params: { status?: string; organizationId?: string; page: number; pageSize: number }) {
  const platform = ctx.scope === 'PLATFORM';
  return withPlatform(async (tx) => {
    const where: Prisma.CreditRequestWhereInput = {
      ...(platform ? (params.organizationId ? { organizationId: params.organizationId } : {}) : { organizationId: ctx.orgId! }),
      ...(params.status === 'OPEN' ? { status: { in: OPEN } } : params.status ? { status: params.status as CreditRequestStatus } : {}),
    };
    const [total, rows] = await Promise.all([
      tx.creditRequest.count({ where }),
      tx.creditRequest.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (params.page - 1) * params.pageSize, take: params.pageSize }),
    ]);
    const users = await tx.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => [r.requestedById, r.decidedById].filter((x): x is string => Boolean(x))))] } }, select: { id: true, name: true, email: true } });
    const orgs = platform ? await tx.organization.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.organizationId))] } }, select: { id: true, name: true } }) : [];
    return {
      total,
      rows: rows.map((r) => serializeRequest({
        ...r, requester: users.find((u) => u.id === r.requestedById) ?? null, organization: orgs.find((o) => o.id === r.organizationId) ?? null,
        decidedBy: platform ? (users.find((u) => u.id === r.decidedById) ?? null) : null,
        // Clients never see internal notes on open requests.
        ...(platform ? {} : { adminNote: r.status === 'REJECTED' ? r.adminNote : null }),
      })),
    };
  });
}

export async function getCreditRequest(ctx: AuthContext, id: string) {
  const platform = ctx.scope === 'PLATFORM';
  return withPlatform(async (tx) => {
    const r = await tx.creditRequest.findUnique({ where: { id } });
    if (!r || (!platform && r.organizationId !== ctx.orgId)) throw notFound('Credit request');
    const users = await tx.user.findMany({ where: { id: { in: [r.requestedById, r.decidedById].filter((x): x is string => Boolean(x)) } }, select: { id: true, name: true, email: true } });
    const org = await tx.organization.findUnique({ where: { id: r.organizationId }, select: { name: true } });
    return serializeRequest({
      ...r, organization: org, requester: users.find((u) => u.id === r.requestedById) ?? null,
      decidedBy: platform ? (users.find((u) => u.id === r.decidedById) ?? null) : null,
      ...(platform ? {} : { adminNote: r.status === 'REJECTED' ? r.adminNote : null }),
    });
  });
}

export async function listCreditEntries(ctx: AuthContext, params: { organizationId?: string; type?: string; page: number; pageSize: number }) {
  const platform = ctx.scope === 'PLATFORM';
  return withPlatform(async (tx) => {
    const where: Prisma.CreditEntryWhereInput = {
      ...(platform ? (params.organizationId ? { organizationId: params.organizationId } : {}) : { organizationId: ctx.orgId! }),
      ...(params.type ? { type: { in: params.type.split(',') as CreditEntryType[] } } : {}),
    };
    const [total, rows] = await Promise.all([
      tx.creditEntry.count({ where }),
      tx.creditEntry.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (params.page - 1) * params.pageSize, take: params.pageSize }),
    ]);
    const reqIds = [...new Set(rows.map((r) => r.leadRequestId).filter((x): x is string => Boolean(x)))];
    const crIds = [...new Set(rows.map((r) => r.creditRequestId).filter((x): x is string => Boolean(x)))];
    const [leadReqs, creditReqs, actors, orgs] = await Promise.all([
      reqIds.length ? tx.leadRequest.findMany({ where: { id: { in: reqIds } }, select: { id: true, code: true } }) : [],
      crIds.length ? tx.creditRequest.findMany({ where: { id: { in: crIds } }, select: { id: true, code: true } }) : [],
      platform ? tx.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.actorId).filter((x): x is string => Boolean(x)))] } }, select: { id: true, name: true } }) : [],
      platform ? tx.organization.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.organizationId))] } }, select: { id: true, name: true } }) : [],
    ]);
    return {
      total,
      rows: rows.map((r) => ({
        id: r.id, type: r.type, credits: r.credits, balanceAfter: r.balanceAfter, note: r.note, createdAt: r.createdAt,
        expiresAt: r.credits > 0 ? r.expiresAt : null, remaining: r.credits > 0 ? r.remaining : null,
        leadRequest: leadReqs.find((x) => x.id === r.leadRequestId) ?? null, creditRequest: creditReqs.find((x) => x.id === r.creditRequestId) ?? null,
        ...(platform ? { actor: actors.find((a) => a.id === r.actorId)?.name ?? null, organization: orgs.find((o) => o.id === r.organizationId) ?? null } : {}),
      })),
    };
  });
}

/** A workspace's balance, what expires soon and how credits can be bought and spent. */
export async function creditSummary(ctx: AuthContext, orgId = ctx.orgId!) {
  const s = await getCreditSettings();
  const pricing = await getSetting('pricing');
  return withPlatform(async (tx) => {
    const w = await lockWallet(tx, orgId, s);
    const soon = new Date(Date.now() + 30 * 86400_000);
    const expiring = await tx.creditEntry.aggregate({ where: { organizationId: orgId, remaining: { gt: 0 }, expiresAt: { lte: soon } }, _sum: { remaining: true }, _min: { expiresAt: true } });
    const open = await tx.creditRequest.count({ where: { organizationId: orgId, status: { in: OPEN } } });
    const o = s.overrides.find((x) => x.organizationId === orgId);
    const { onlinePaymentsEnabled } = await import('./payments');
    return {
      enabled: s.enabled, label: s.label, currency: pricing.currency, onlinePayment: await onlinePaymentsEnabled(),
      balance: w.balance, lifetimeIn: w.lifetimeIn, lifetimeSpent: w.lifetimeSpent,
      expiringSoon: expiring._sum.remaining ?? 0, nextExpiry: expiring._min.expiresAt,
      openRequests: open,
      rules: {
        costMode: s.costMode, creditValue: s.creditValue, fixedCreditsPerLead: s.fixedCreditsPerLead, spendDiscountPct: o?.spendDiscountPct ?? s.spendDiscountPct,
        packages: s.packages.filter((p) => p.enabled), custom: s.custom, bonusTiers: s.bonusTiers, clientBonusPct: o?.bonusPct ?? 0,
        taxPct: s.taxPct, expiryDays: s.expiryDays, autoDeliver: s.autoDeliver, allowInvoice: s.allowInvoice, paymentInstructions: s.paymentInstructions,
      },
    };
  });
}

/** Platform overview: balances across workspaces, sales, spend and the open queue. */
export async function creditOverview(params: { q?: string } = {}) {
  return withPlatform(async (tx) => {
    const [wallets, sold, spent, revenue, open, awaiting, refunds, expired] = await Promise.all([
      tx.creditWallet.findMany({ orderBy: { balance: 'desc' }, take: 500 }),
      tx.creditEntry.aggregate({ where: { type: { in: ['PURCHASE', 'BONUS', 'WELCOME', 'GRANT'] } }, _sum: { credits: true } }),
      tx.creditEntry.aggregate({ where: { type: 'SPEND' }, _sum: { credits: true } }),
      tx.creditRequest.groupBy({ by: ['currency'], where: { status: 'COMPLETED' }, _sum: { total: true }, _count: true }),
      tx.creditRequest.count({ where: { status: 'PENDING' } }),
      tx.creditRequest.count({ where: { status: 'AWAITING_PAYMENT' } }),
      tx.creditEntry.aggregate({ where: { type: 'REFUND' }, _sum: { credits: true } }),
      tx.creditEntry.aggregate({ where: { type: 'EXPIRY' }, _sum: { credits: true } }),
    ]);
    const orgs = await tx.organization.findMany({ where: { id: { in: wallets.map((w) => w.organizationId) }, ...(params.q ? { name: { contains: params.q, mode: 'insensitive' } } : {}) }, select: { id: true, name: true } });
    const soon = new Date(Date.now() + 30 * 86400_000);
    const exp = await tx.creditEntry.groupBy({ by: ['organizationId'], where: { remaining: { gt: 0 }, expiresAt: { lte: soon } }, _sum: { remaining: true } });
    const last = await tx.creditEntry.groupBy({ by: ['organizationId'], _max: { createdAt: true } });
    return {
      totals: {
        outstanding: wallets.reduce((a, w) => a + w.balance, 0),
        issued: sold._sum.credits ?? 0, spent: -(spent._sum.credits ?? 0) - (refunds._sum.credits ?? 0), expired: -(expired._sum.credits ?? 0),
        revenue: revenue.map((r) => ({ currency: r.currency, total: Number(r._sum.total ?? 0), count: r._count })),
        pendingRequests: open, awaitingPayment: awaiting,
      },
      wallets: wallets.filter((w) => orgs.some((o) => o.id === w.organizationId)).map((w) => ({
        organizationId: w.organizationId, name: orgs.find((o) => o.id === w.organizationId)!.name, balance: w.balance, lifetimeIn: w.lifetimeIn, lifetimeSpent: w.lifetimeSpent,
        expiringSoon: exp.find((e) => e.organizationId === w.organizationId)?._sum.remaining ?? 0, lastActivity: last.find((l) => l.organizationId === w.organizationId)?._max.createdAt ?? w.updatedAt,
      })),
    };
  });
}
