
import { z } from 'zod';
import { audit } from '../audit';
import type { AuthContext } from '../auth/context';
import { withPlatform } from '../db';
import { notFound } from '../errors';

/**
 * Lead suppliers: who supplies which lead `source` values, what each lead costs, and how each supplier
 * performs — sell-through, revenue, profit, quality reports, invalid leads and client win rates.
 */

export const supplierInput = z.object({
  name: z.string().trim().min(2).max(120),
  contactName: z.string().trim().max(120).nullable().optional(),
  email: z.string().trim().email().max(254).nullable().optional().or(z.literal('').transform(() => null)),
  phone: z.string().trim().max(40).nullable().optional(),
  sources: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  costPerLead: z.number().min(0).max(1_000_000).default(0),
  currency: z.string().trim().length(3).default('INR'),
  status: z.enum(['ACTIVE', 'PAUSED', 'BLOCKED']).default('ACTIVE'),
  notes: z.string().trim().max(2000).nullable().optional(),
});

const norm = (s: string) => s.trim().toLowerCase();

export async function listSuppliers() {
  return withPlatform((tx) => tx.leadSupplier.findMany({ orderBy: { name: 'asc' } })).then((rows) => rows.map((r) => ({ ...r, costPerLead: Number(r.costPerLead) })));
}

export async function saveSupplier(ctx: AuthContext, id: string | null, input: z.infer<typeof supplierInput>) {
  const data = { ...input, sources: [...new Set(input.sources.map((s) => s.trim()).filter(Boolean))] };
  return withPlatform(async (tx) => {
    const before = id ? await tx.leadSupplier.findUnique({ where: { id } }) : null;
    if (id && !before) throw notFound('Supplier');
    const s = id ? await tx.leadSupplier.update({ where: { id }, data }) : await tx.leadSupplier.create({ data });
    const plain = (x: typeof s) => ({ ...x, costPerLead: Number(x.costPerLead) });
    await audit(tx, ctx, { action: id ? 'supplier.updated' : 'supplier.created', targetType: 'lead_supplier', targetId: s.id, organizationId: null, before: before ? plain(before) : undefined, after: plain(s) });
    return { ...s, costPerLead: Number(s.costPerLead) };
  });
}

export async function deleteSupplier(ctx: AuthContext, id: string) {
  return withPlatform(async (tx) => {
    const s = await tx.leadSupplier.findUnique({ where: { id } });
    if (!s) throw notFound('Supplier');
    await tx.leadSupplier.delete({ where: { id } });
    await audit(tx, ctx, { action: 'supplier.deleted', targetType: 'lead_supplier', targetId: id, organizationId: null, before: { ...s, costPerLead: Number(s.costPerLead) } });
    return { ok: true };
  });
}

/** Archives a supplier's unsold leads so they leave the marketplace (e.g. after blocking it). */
export async function pullSupplierStock(ctx: AuthContext, id: string) {
  return withPlatform(async (tx) => {
    const s = await tx.leadSupplier.findUnique({ where: { id } });
    if (!s) throw notFound('Supplier');
    if (!s.sources.length) return { archived: 0 };
    const r = await tx.$executeRaw`UPDATE leads SET "archivedAt" = now(), "updatedAt" = now()
      WHERE "allocationStatus" = 'UNALLOCATED' AND "archivedAt" IS NULL AND lower(source) = ANY(${s.sources.map(norm)}::text[])`;
    await audit(tx, ctx, { action: 'supplier.stock_pulled', targetType: 'lead_supplier', targetId: id, organizationId: null, metadata: { archived: r, sources: s.sources } });
    return { archived: r };
  }, { timeout: 60_000 });
}

type SourceStats = { src: string; imported: number; available: number; sold: number; revenue: number; disputes: number; approved: number; invalid: number; won: number; worked: number };

/** Performance by lead source over a window, mapped onto suppliers. */
export async function supplierPerformance(params: { days: number }) {
  const since = new Date(Date.now() - params.days * 86400_000);
  return withPlatform(async (tx) => {
    const [suppliers, imported, available, sold, disputes, invalid, outcomes] = await Promise.all([
      tx.leadSupplier.findMany({ orderBy: { name: 'asc' } }),
      tx.$queryRaw<{ src: string; c: number }[]>`SELECT lower(coalesce(source, '')) AS src, COUNT(*)::int AS c FROM leads WHERE "createdAt" >= ${since} AND "mergedIntoId" IS NULL GROUP BY 1`,
      tx.$queryRaw<{ src: string; c: number }[]>`SELECT lower(coalesce(source, '')) AS src, COUNT(*)::int AS c FROM leads WHERE "allocationStatus" = 'UNALLOCATED' AND "archivedAt" IS NULL AND "mergedIntoId" IS NULL AND quality = 'VALID' GROUP BY 1`,
      tx.$queryRaw<{ src: string; c: number; revenue: number }[]>`
        SELECT lower(coalesce(l.source, '')) AS src, COUNT(*)::int AS c, COALESCE(SUM(CASE WHEN i.free THEN 0 ELSE i.price END), 0)::float AS revenue
        FROM lead_request_items i JOIN lead_requests r ON r.id = i."requestId" JOIN leads l ON l.id = i."leadId"
        WHERE i.status = 'DELIVERED' AND r."decidedAt" >= ${since} GROUP BY 1`,
      tx.$queryRaw<{ src: string; c: number; approved: number }[]>`
        SELECT lower(coalesce(l.source, '')) AS src, COUNT(*)::int AS c, COUNT(*) FILTER (WHERE d.status = 'APPROVED')::int AS approved
        FROM lead_disputes d JOIN leads l ON l.id = d."leadId" WHERE d."createdAt" >= ${since} GROUP BY 1`,
      tx.$queryRaw<{ src: string; c: number }[]>`SELECT lower(coalesce(source, '')) AS src, COUNT(*)::int AS c FROM leads WHERE quality = 'INVALID' AND "updatedAt" >= ${since} GROUP BY 1`,
      tx.$queryRaw<{ src: string; worked: number; won: number }[]>`
        SELECT lower(coalesce(l.source, '')) AS src, COUNT(*) FILTER (WHERE c."firstContactAt" IS NOT NULL)::int AS worked, COUNT(*) FILTER (WHERE c.status = 'CONVERTED')::int AS won
        FROM client_leads c JOIN leads l ON l.id = c."leadId" WHERE c."createdAt" >= ${since} AND c."revokedAt" IS NULL GROUP BY 1`,
    ]);
    const by = new Map<string, SourceStats>();
    const get = (src: string) => { const k = src ?? ''; if (!by.has(k)) by.set(k, { src: k, imported: 0, available: 0, sold: 0, revenue: 0, disputes: 0, approved: 0, invalid: 0, won: 0, worked: 0 }); return by.get(k)!; };
    for (const r of imported) get(r.src).imported = r.c;
    for (const r of available) get(r.src).available = r.c;
    for (const r of sold) { get(r.src).sold = r.c; get(r.src).revenue = r.revenue; }
    for (const r of disputes) { get(r.src).disputes = r.c; get(r.src).approved = r.approved; }
    for (const r of invalid) get(r.src).invalid = r.c;
    for (const r of outcomes) { get(r.src).worked = r.worked; get(r.src).won = r.won; }

    const sum = (rows: SourceStats[]) => rows.reduce((a, r) => ({ imported: a.imported + r.imported, available: a.available + r.available, sold: a.sold + r.sold, revenue: a.revenue + r.revenue, disputes: a.disputes + r.disputes, approved: a.approved + r.approved, invalid: a.invalid + r.invalid, won: a.won + r.won, worked: a.worked + r.worked }), { imported: 0, available: 0, sold: 0, revenue: 0, disputes: 0, approved: 0, invalid: 0, won: 0, worked: 0 });
    const claimed = new Set<string>();
    const rows = suppliers.map((s) => {
      const keys = s.sources.map(norm);
      keys.forEach((k) => claimed.add(k));
      const t = sum(keys.map((k) => by.get(k)).filter((x): x is SourceStats => Boolean(x)));
      const cost = t.imported * Number(s.costPerLead);
      const reportRate = t.sold ? Math.round((t.disputes / t.sold) * 1000) / 10 : 0;
      const winRate = t.worked ? Math.round((t.won / t.worked) * 1000) / 10 : 0;
      const sellThrough = t.sold + t.available ? Math.round((t.sold / (t.sold + t.available)) * 1000) / 10 : 0;
      // Quality 0–100: complaints and invalid leads hurt, wins help.
      const invalidRate = t.imported ? (t.invalid / t.imported) * 100 : 0;
      const quality = Math.max(0, Math.min(100, Math.round(80 - reportRate * 2 - invalidRate + winRate)));
      return {
        id: s.id, name: s.name, status: s.status, sources: s.sources, costPerLead: Number(s.costPerLead), currency: s.currency, contactName: s.contactName, email: s.email, phone: s.phone, notes: s.notes,
        ...t, cost, profit: Math.round((t.revenue - cost) * 100) / 100, margin: t.revenue ? Math.round(((t.revenue - cost) / t.revenue) * 1000) / 10 : null,
        sellThrough, reportRate, winRate, quality,
      };
    });
    const unassigned = [...by.values()].filter((r) => !claimed.has(r.src) && (r.imported || r.available || r.sold)).sort((a, b) => b.imported + b.available - (a.imported + a.available)).slice(0, 20)
      .map((r) => ({ source: r.src || '(no source)', imported: r.imported, available: r.available, sold: r.sold, revenue: r.revenue }));
    return { days: params.days, suppliers: rows, unassigned };
  });
}

export type SupplierPerf = Awaited<ReturnType<typeof supplierPerformance>>['suppliers'][number];
