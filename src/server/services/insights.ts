import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { AuthContext } from '../auth/context';
import { withPlatform } from '../db';
import { redis } from '../redis';
import { getCreditSettings } from './credits';
import { getPricing, MARKET_AVAILABLE } from './marketplace';
import type { Condition, Filter } from '@/lib/filters';

/**
 * Super-admin business insights: revenue, inventory, demand and receivables.
 * Revenue is reported two ways: billed (invoices raised for delivered leads) and collected
 * (invoices paid + credit purchases). Credits are a liability until spent.
 */

const day = (d: Date) => d.toISOString().slice(0, 10);
const n = (v: unknown) => Number(v ?? 0);

export async function revenueInsights(params: { days: number }) {
  const since = new Date(Date.now() - params.days * 86400_000);
  const prevSince = new Date(since.getTime() - params.days * 86400_000);
  const [p, cs] = await Promise.all([getPricing(), getCreditSettings()]);
  return withPlatform(async (tx) => {
    const [invoiced, prevInvoiced, paidInvoices, creditSales, prevCreditSales, creditSpend, outstandingCredits, due, leadsSold] = await Promise.all([
      tx.leadRequest.aggregate({ where: { paymentMethod: 'INVOICE', billingStatus: { in: ['DUE', 'PAID'] }, decidedAt: { gte: since } }, _sum: { total: true, tax: true }, _count: true }),
      tx.leadRequest.aggregate({ where: { paymentMethod: 'INVOICE', billingStatus: { in: ['DUE', 'PAID'] }, decidedAt: { gte: prevSince, lt: since } }, _sum: { total: true } }),
      tx.leadRequest.aggregate({ where: { paymentMethod: 'INVOICE', billingStatus: 'PAID', paidAt: { gte: since } }, _sum: { total: true } }),
      tx.creditRequest.aggregate({ where: { status: 'COMPLETED', paidAt: { gte: since } }, _sum: { total: true, tax: true, credits: true, bonusCredits: true }, _count: true }),
      tx.creditRequest.aggregate({ where: { status: 'COMPLETED', paidAt: { gte: prevSince, lt: since } }, _sum: { total: true } }),
      tx.creditEntry.aggregate({ where: { type: 'SPEND', createdAt: { gte: since } }, _sum: { credits: true } }),
      tx.creditWallet.aggregate({ _sum: { balance: true } }),
      tx.leadRequest.aggregate({ where: { billingStatus: 'DUE' }, _sum: { total: true }, _count: true }),
      tx.leadRequest.aggregate({ where: { status: { in: ['FULFILLED', 'PARTIAL'] }, decidedAt: { gte: since } }, _sum: { deliveredCount: true, freeApplied: true }, _count: true }),
    ]);
    const series = await tx.$queryRaw<{ d: Date; lead: number; credit: number }[]>`
      WITH days AS (SELECT generate_series(date_trunc('day', ${since}::timestamptz), date_trunc('day', now()), interval '1 day') AS d)
      SELECT days.d,
        COALESCE((SELECT SUM(total) FROM lead_requests r WHERE r."paymentMethod" = 'INVOICE' AND r."billingStatus" IN ('DUE','PAID') AND date_trunc('day', r."decidedAt") = days.d), 0)::float AS lead,
        COALESCE((SELECT SUM(total) FROM credit_requests c WHERE c.status = 'COMPLETED' AND date_trunc('day', c."paidAt") = days.d), 0)::float AS credit
      FROM days ORDER BY days.d`;
    const top = await tx.$queryRaw<{ organizationId: string; leads: number; credits: number }[]>`
      SELECT "organizationId", SUM(leads)::float AS leads, SUM(credits)::float AS credits FROM (
        SELECT "organizationId", total AS leads, 0 AS credits FROM lead_requests WHERE "paymentMethod" = 'INVOICE' AND "billingStatus" IN ('DUE','PAID') AND "decidedAt" >= ${since}
        UNION ALL
        SELECT "organizationId", 0, total FROM credit_requests WHERE status = 'COMPLETED' AND "paidAt" >= ${since}
      ) x GROUP BY "organizationId" ORDER BY SUM(leads) + SUM(credits) DESC LIMIT 10`;
    const orgs = await tx.organization.findMany({ where: { id: { in: top.map((t) => t.organizationId) } }, select: { id: true, name: true } });
    const billed = n(invoiced._sum.total);
    const credit = n(creditSales._sum.total);
    const prev = n(prevInvoiced._sum.total) + n(prevCreditSales._sum.total);
    const gross = billed + credit;
    const orders = invoiced._count + creditSales._count;
    return {
      days: params.days, currency: p.currency,
      totals: {
        gross, billed, creditSales: credit, collected: n(paidInvoices._sum.total) + credit,
        tax: n(invoiced._sum.tax) + n(creditSales._sum.tax), change: prev ? Math.round(((gross - prev) / prev) * 1000) / 10 : null,
        orders, aov: orders ? Math.round((gross / orders) * 100) / 100 : 0,
        leadsSold: n(leadsSold._sum.deliveredCount) - n(leadsSold._sum.freeApplied), freeLeads: n(leadsSold._sum.freeApplied),
        avgPricePerLead: n(leadsSold._sum.deliveredCount) - n(leadsSold._sum.freeApplied) > 0 ? Math.round((billed / Math.max(1, n(leadsSold._sum.deliveredCount) - n(leadsSold._sum.freeApplied))) * 100) / 100 : 0,
      },
      credits: {
        sold: n(creditSales._sum.credits) + n(creditSales._sum.bonusCredits), spent: -n(creditSpend._sum.credits),
        outstanding: n(outstandingCredits._sum.balance), liability: Math.round(n(outstandingCredits._sum.balance) * cs.creditValue * 100) / 100,
      },
      receivables: { amount: n(due._sum.total), count: due._count },
      series: series.map((r) => ({ day: day(new Date(r.d)), leads: Math.round(r.lead * 100) / 100, credits: Math.round(r.credit * 100) / 100 })),
      topClients: top.map((t) => ({ id: t.organizationId, name: orgs.find((o) => o.id === t.organizationId)?.name ?? '—', leads: t.leads, credits: t.credits, total: t.leads + t.credits })),
    };
  });
}

export async function inventoryInsights() {
  const p = await getPricing();
  const d = p.dynamic;
  // Age at which depreciation hits its floor (if age pricing is on).
  const floorDays = d.enabled && d.age.enabled && d.age.pct > 0 && d.age.floorPct > 0
    ? d.age.graceDays + Math.ceil(Math.log(d.age.floorPct / 100) / Math.log(1 - d.age.pct / 100)) * d.age.everyDays : null;
  return withPlatform(async (tx) => {
    const now = Date.now();
    const ago = (days: number) => new Date(now - days * 86400_000);
    const [total, fresh, b7, b30, b90, atFloor, byIndustry, byState, sold30] = await Promise.all([
      tx.lead.count({ where: MARKET_AVAILABLE }),
      tx.lead.count({ where: { AND: [MARKET_AVAILABLE, { distributionCount: 0 }] } }),
      tx.lead.count({ where: { AND: [MARKET_AVAILABLE, { createdAt: { gte: ago(7) } }] } }),
      tx.lead.count({ where: { AND: [MARKET_AVAILABLE, { createdAt: { gte: ago(30), lt: ago(7) } }] } }),
      tx.lead.count({ where: { AND: [MARKET_AVAILABLE, { createdAt: { gte: ago(90), lt: ago(30) } }] } }),
      floorDays != null ? tx.lead.count({ where: { AND: [MARKET_AVAILABLE, { createdAt: { lt: ago(floorDays) } }] } }) : Promise.resolve(0),
      tx.lead.groupBy({ by: ['industry'], where: MARKET_AVAILABLE, _count: true, orderBy: { _count: { industry: 'desc' } }, take: 30 }),
      tx.lead.groupBy({ by: ['state'], where: MARKET_AVAILABLE, _count: true, orderBy: { _count: { state: 'desc' } }, take: 15 }),
      tx.$queryRaw<{ industry: string | null; sold: number }[]>`
        SELECT l.industry, COUNT(*)::int AS sold FROM lead_request_items i JOIN lead_requests r ON r.id = i."requestId" JOIN leads l ON l.id = i."leadId"
        WHERE i.status = 'DELIVERED' AND r."decidedAt" >= ${ago(30)} GROUP BY l.industry`,
    ]);
    const soldBy = new Map(sold30.map((s) => [s.industry ?? '—', s.sold]));
    const industries = byIndustry.map((r) => {
      const key = r.industry ?? '—';
      const sold = soldBy.get(key) ?? 0;
      return { industry: key, available: r._count, sold30: sold, sellThrough: sold + r._count ? Math.round((sold / (sold + r._count)) * 1000) / 10 : 0, daysOfCover: sold ? Math.round(r._count / (sold / 30)) : null };
    });
    // Industries clients bought that have run out entirely.
    for (const [industry, sold] of soldBy) if (!industries.some((i) => i.industry === industry)) industries.push({ industry, available: 0, sold30: sold, sellThrough: 100, daysOfCover: 0 });
    return {
      total, fresh, resold: total - fresh, floorDays, atFloor,
      aging: [{ label: 'Under 7 days', count: b7 }, { label: '7–30 days', count: b30 }, { label: '30–90 days', count: b90 }, { label: 'Over 90 days', count: Math.max(0, total - b7 - b30 - b90) }],
      industries: industries.sort((a, b) => b.available + b.sold30 - (a.available + a.sold30)),
      states: byState.map((s) => ({ state: s.state ?? '—', available: s._count })),
    };
  });
}

// ── Demand ─────────────────────────────────────────────────────────

const valuesOf = (cs: Condition[], field: string) => cs.filter((c) => c.field === field && (c.op === 'in' || c.op === 'eq')).flatMap((c) => (Array.isArray(c.value) ? c.value.map(String) : c.value != null ? [String(c.value)] : []));

/** Records a client marketplace search (deduplicated per user per hour). Never throws. */
export async function logMarketSearch(ctx: AuthContext, filter: Filter, results: number) {
  try {
    if (ctx.scope !== 'ORGANIZATION' || !ctx.orgId || !filter.conditions.length) return;
    const key = `msearch:${ctx.user.id}:${createHash('sha1').update(JSON.stringify(filter.conditions)).digest('hex').slice(0, 16)}`;
    const fresh = await redis().set(key, '1', 'EX', 3600, 'NX').catch(() => 'OK');
    if (fresh !== 'OK') return;
    const cs = filter.conditions;
    await withPlatform((tx) => tx.marketSearchLog.create({
      data: {
        organizationId: ctx.orgId!, userId: ctx.user.id, conditions: cs as unknown as Prisma.InputJsonValue, results,
        industries: valuesOf(cs, 'industry').slice(0, 20), locations: [...valuesOf(cs, 'state'), ...valuesOf(cs, 'country')].slice(0, 20), keywords: valuesOf(cs, 'keyword').slice(0, 10),
      },
    }));
  } catch { /* analytics only */ }
}

export async function demandInsights(params: { days: number }) {
  const since = new Date(Date.now() - params.days * 86400_000);
  return withPlatform(async (tx) => {
    const [searches, zero, clients, ind, loc, kw, zeroInd, zeroLoc, saved] = await Promise.all([
      tx.marketSearchLog.count({ where: { createdAt: { gte: since } } }),
      tx.marketSearchLog.count({ where: { createdAt: { gte: since }, results: 0 } }),
      tx.marketSearchLog.groupBy({ by: ['organizationId'], where: { createdAt: { gte: since } } }),
      tx.$queryRaw<{ v: string; c: number }[]>`SELECT unnest(industries) AS v, COUNT(*)::int AS c FROM market_search_logs WHERE "createdAt" >= ${since} GROUP BY 1 ORDER BY 2 DESC LIMIT 15`,
      tx.$queryRaw<{ v: string; c: number }[]>`SELECT unnest(locations) AS v, COUNT(*)::int AS c FROM market_search_logs WHERE "createdAt" >= ${since} GROUP BY 1 ORDER BY 2 DESC LIMIT 15`,
      tx.$queryRaw<{ v: string; c: number }[]>`SELECT unnest(keywords) AS v, COUNT(*)::int AS c FROM market_search_logs WHERE "createdAt" >= ${since} GROUP BY 1 ORDER BY 2 DESC LIMIT 15`,
      tx.$queryRaw<{ v: string; c: number }[]>`SELECT unnest(industries) AS v, COUNT(*)::int AS c FROM market_search_logs WHERE "createdAt" >= ${since} AND results = 0 GROUP BY 1 ORDER BY 2 DESC LIMIT 10`,
      tx.$queryRaw<{ v: string; c: number }[]>`SELECT unnest(locations) AS v, COUNT(*)::int AS c FROM market_search_logs WHERE "createdAt" >= ${since} AND results = 0 GROUP BY 1 ORDER BY 2 DESC LIMIT 10`,
      tx.savedSearch.findMany({ where: { active: true }, select: { filter: true, autoBuy: true } }),
    ]);
    // Stock for what people look for, so unmet demand stands out.
    const stock = await tx.lead.groupBy({ by: ['industry'], where: { AND: [MARKET_AVAILABLE, { industry: { in: ind.map((i) => i.v) } }] }, _count: true });
    const savedInd = new Map<string, { searches: number; autoBuy: number }>();
    for (const s of saved) for (const v of valuesOf((s.filter as { conditions?: Condition[] }).conditions ?? [], 'industry')) {
      const e = savedInd.get(v) ?? { searches: 0, autoBuy: 0 };
      e.searches++; if (s.autoBuy) e.autoBuy++;
      savedInd.set(v, e);
    }
    return {
      days: params.days, searches, zeroResults: zero, searchingClients: clients.length,
      industries: ind.map((i) => ({ value: i.v, searches: i.c, stock: stock.find((s) => s.industry === i.v)?._count ?? 0 })),
      locations: loc.map((l) => ({ value: l.v, searches: l.c })),
      keywords: kw.map((k) => ({ value: k.v, searches: k.c })),
      unmet: { industries: zeroInd.map((z) => ({ value: z.v, searches: z.c })), locations: zeroLoc.map((z) => ({ value: z.v, searches: z.c })) },
      savedSearches: [...savedInd.entries()].map(([value, e]) => ({ value, ...e })).sort((a, b) => b.searches - a.searches).slice(0, 15),
    };
  });
}

// ── Receivables ────────────────────────────────────────────────────

export async function receivables() {
  return withPlatform(async (tx) => {
    const due = await tx.leadRequest.findMany({ where: { billingStatus: 'DUE' }, select: { id: true, code: true, invoiceNumber: true, organizationId: true, total: true, currency: true, decidedAt: true, createdAt: true }, orderBy: { decidedAt: 'asc' }, take: 500 });
    const credit = await tx.creditRequest.findMany({ where: { status: { in: ['PENDING', 'AWAITING_PAYMENT'] } }, select: { id: true, code: true, organizationId: true, total: true, currency: true, status: true, clientReference: true, createdAt: true }, orderBy: { createdAt: 'asc' }, take: 500 });
    const orgs = await tx.organization.findMany({ where: { id: { in: [...new Set([...due.map((d) => d.organizationId), ...credit.map((c) => c.organizationId)])] } }, select: { id: true, name: true } });
    const name = (id: string) => orgs.find((o) => o.id === id)?.name ?? '—';
    const age = (d: Date) => Math.floor((Date.now() - d.getTime()) / 86400_000);
    const buckets = [{ label: '0–15 days', min: 0, max: 15 }, { label: '16–30 days', min: 16, max: 30 }, { label: '31–60 days', min: 31, max: 60 }, { label: 'Over 60 days', min: 61, max: Infinity }]
      .map((b) => { const xs = due.filter((d) => { const a = age(d.decidedAt ?? d.createdAt); return a >= b.min && a <= b.max; }); return { label: b.label, count: xs.length, amount: xs.reduce((s, x) => s + Number(x.total), 0) }; });
    return {
      buckets, total: due.reduce((s, d) => s + Number(d.total), 0),
      invoices: due.map((d) => ({ id: d.id, code: d.code, invoiceNumber: d.invoiceNumber, client: name(d.organizationId), organizationId: d.organizationId, amount: Number(d.total), currency: d.currency, ageDays: age(d.decidedAt ?? d.createdAt) })).sort((a, b) => b.ageDays - a.ageDays).slice(0, 50),
      creditRequests: credit.map((c) => ({ id: c.id, code: c.code, client: name(c.organizationId), amount: Number(c.total), currency: c.currency, status: c.status, reported: Boolean(c.clientReference), ageDays: age(c.createdAt) })),
    };
  });
}
