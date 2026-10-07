import type { Prisma } from '@prisma/client';
import { DEFAULT_FINANCE, financeSettingsSchema, financialYear, gstSplit, stateFromGstin, type FinanceSettings } from '@/lib/finance';
import { audit } from '../audit';
import type { AuthContext } from '../auth/context';
import { withPlatform, type Tx } from '../db';
import { notFound } from '../errors';
import { logger } from '../logger';
import { getSetting, invalidateSetting } from '../settings';

/**
 * Tax invoices: one per paid sale (an invoiced lead purchase, or a credit purchase), numbered
 * sequentially per financial year (e.g. INV/2026-27/0001). Seller and buyer details are snapshotted
 * at issue, so invoices never change. GST is split CGST+SGST within the seller's state, IGST otherwise.
 * Lead purchases paid with credits are not invoiced again — the credit purchase was the taxable sale.
 */

export async function getFinance(): Promise<FinanceSettings> {
  const raw = await getSetting('finance');
  const parsed = financeSettingsSchema.safeParse({ ...DEFAULT_FINANCE, ...(raw as object) });
  return parsed.success ? parsed.data : DEFAULT_FINANCE;
}

export async function saveFinance(ctx: AuthContext, input: FinanceSettings) {
  const value = financeSettingsSchema.parse(input);
  if (value.seller.gstin && !value.seller.state) value.seller.state = stateFromGstin(value.seller.gstin) ?? '';
  const before = await getFinance();
  await withPlatform(async (tx) => {
    await tx.platformSetting.upsert({ where: { key: 'finance' }, create: { key: 'finance', value: value as unknown as Prisma.InputJsonValue, updatedById: ctx.user.id }, update: { value: value as unknown as Prisma.InputJsonValue, updatedById: ctx.user.id } });
    await audit(tx, ctx, { action: 'settings.finance.updated', targetType: 'platform_setting', targetId: 'finance', organizationId: null, before, after: value });
  });
  invalidateSetting('finance');
  return value;
}

type Line = { description: string; sac: string; qty: number; unitCents: number; amountCents: number };

async function nextNumber(tx: Tx, f: FinanceSettings, at: Date) {
  // Serialise numbering across concurrent issuers.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('tax_invoices'))`;
  const fy = financialYear(at, f.invoices.fyStartMonth);
  const last = await tx.taxInvoice.findFirst({ where: { fy }, orderBy: { seq: 'desc' }, select: { seq: true } });
  const seq = (last?.seq ?? 0) + 1;
  return { fy, seq, number: `${f.invoices.prefix}/${fy}/${String(seq).padStart(4, '0')}` };
}

async function buyerOf(tx: Tx, orgId: string) {
  const o = await tx.organization.findUniqueOrThrow({ where: { id: orgId }, select: { name: true, legalName: true, gstin: true, billingState: true, address: true, contactEmail: true, code: true } });
  return { name: o.legalName || o.name, gstin: o.gstin ?? null, state: o.billingState || stateFromGstin(o.gstin) || null, address: o.address ?? null, email: o.contactEmail ?? null, code: o.code };
}

/** Issues the invoice for a sale (idempotent per sale). Returns null when invoicing is off or nothing is payable. */
export async function issueInvoice(kind: 'LEAD_PURCHASE' | 'CREDIT_PURCHASE', refId: string) {
  const f = await getFinance();
  if (!f.invoices.enabled) return null;
  try {
    return await withPlatform(async (tx) => {
      const existing = await tx.taxInvoice.findUnique({ where: { kind_refId: { kind, refId } } });
      if (existing) return existing;
      let orgId: string, currency: string, lines: Line[], taxableCents: number, taxCents: number, paid: boolean;
      if (kind === 'CREDIT_PURCHASE') {
        const r = await tx.creditRequest.findUnique({ where: { id: refId } });
        if (!r || r.status !== 'COMPLETED' || Number(r.total) <= 0) return null;
        orgId = r.organizationId; currency = r.currency; paid = true;
        taxableCents = Math.round(Number(r.amount) * 100); taxCents = Math.round(Number(r.tax) * 100);
        lines = [{ description: `Lead credits${r.packageName ? ` — ${r.packageName} pack` : ''} (${r.credits.toLocaleString()} credits${r.bonusCredits ? ` + ${r.bonusCredits.toLocaleString()} bonus` : ''}) · ${r.code}`, sac: f.invoices.sac, qty: 1, unitCents: taxableCents, amountCents: taxableCents }];
      } else {
        const r = await tx.leadRequest.findUnique({ where: { id: refId } });
        if (!r || r.paymentMethod === 'CREDITS' || !['DUE', 'PAID'].includes(r.billingStatus) || Number(r.total) <= 0) return null;
        orgId = r.organizationId; currency = r.currency; paid = r.billingStatus === 'PAID';
        taxCents = Math.round(Number(r.tax) * 100);
        const sub = Math.round(Number(r.subtotal) * 100), disc = Math.round((Number(r.discount) + Number(r.couponDiscount)) * 100);
        taxableCents = sub - disc;
        const paidLeads = Math.max(1, r.deliveredCount - r.freeApplied);
        lines = [{ description: `Verified business leads delivered · request ${r.code}`, sac: f.invoices.sac, qty: paidLeads, unitCents: Math.round(sub / paidLeads), amountCents: sub }];
        if (disc > 0) lines.push({ description: `Discount${r.couponCode ? ` (coupon ${r.couponCode})` : ''}`, sac: f.invoices.sac, qty: 1, unitCents: -disc, amountCents: -disc });
      }
      const buyer = await buyerOf(tx, orgId);
      const split = gstSplit(taxCents, f.seller.state, buyer.state);
      const n = await nextNumber(tx, f, new Date());
      return tx.taxInvoice.create({
        data: {
          ...n, kind, refId, organizationId: orgId, currency, paid,
          seller: f.seller as unknown as Prisma.InputJsonValue, buyer: buyer as unknown as Prisma.InputJsonValue, lines: lines as unknown as Prisma.InputJsonValue,
          taxable: taxableCents / 100, cgst: split.cgst / 100, sgst: split.sgst / 100, igst: split.igst / 100, total: (taxableCents + taxCents) / 100,
        },
      });
    });
  } catch (err) {
    logger.error({ err, kind, refId }, 'invoice issue failed');
    return null;
  }
}

export async function markInvoicePaid(refId: string, paid: boolean) {
  await withPlatform((tx) => tx.taxInvoice.updateMany({ where: { kind: 'LEAD_PURCHASE', refId }, data: { paid } })).catch(() => null);
}

const serialize = (i: Prisma.TaxInvoiceGetPayload<object>) => ({ ...i, taxable: Number(i.taxable), cgst: Number(i.cgst), sgst: Number(i.sgst), igst: Number(i.igst), total: Number(i.total) });

export async function listInvoices(ctx: AuthContext, params: { organizationId?: string; fy?: string; page: number; pageSize: number }) {
  const platform = ctx.scope === 'PLATFORM';
  return withPlatform(async (tx) => {
    const where: Prisma.TaxInvoiceWhereInput = { ...(platform ? (params.organizationId ? { organizationId: params.organizationId } : {}) : { organizationId: ctx.orgId! }), ...(params.fy ? { fy: params.fy } : {}) };
    const [total, rows, sums] = await Promise.all([
      tx.taxInvoice.count({ where }),
      tx.taxInvoice.findMany({ where, orderBy: [{ fy: 'desc' }, { seq: 'desc' }], skip: (params.page - 1) * params.pageSize, take: params.pageSize }),
      tx.taxInvoice.aggregate({ where, _sum: { taxable: true, cgst: true, sgst: true, igst: true, total: true } }),
    ]);
    return { total, rows: rows.map(serialize), sums: { taxable: Number(sums._sum.taxable ?? 0), cgst: Number(sums._sum.cgst ?? 0), sgst: Number(sums._sum.sgst ?? 0), igst: Number(sums._sum.igst ?? 0), total: Number(sums._sum.total ?? 0) } };
  });
}

export async function getInvoice(ctx: AuthContext, id: string) {
  const i = await withPlatform((tx) => tx.taxInvoice.findUnique({ where: { id } }));
  if (!i || (ctx.scope !== 'PLATFORM' && i.organizationId !== ctx.orgId)) throw notFound('Invoice');
  return serialize(i);
}

/** GST summary for filing (by month): taxable value and CGST / SGST / IGST. */
export async function gstSummary(fy: string) {
  return withPlatform((tx) => tx.$queryRaw<{ month: string; invoices: number; taxable: number; cgst: number; sgst: number; igst: number; total: number }[]>`
    SELECT to_char("issuedAt", 'YYYY-MM') AS month, COUNT(*)::int AS invoices, SUM(taxable)::float AS taxable, SUM(cgst)::float AS cgst, SUM(sgst)::float AS sgst, SUM(igst)::float AS igst, SUM(total)::float AS total
    FROM tax_invoices WHERE fy = ${fy} GROUP BY 1 ORDER BY 1`);
}
