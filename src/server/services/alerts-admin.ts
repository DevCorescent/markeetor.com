import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { ALERT_METRIC_KEYS, type AlertMetric } from '@/lib/finance';
import { audit } from '../audit';
import type { AuthContext } from '../auth/context';
import { withPlatform } from '../db';
import { notFound } from '../errors';
import { queue, QUEUE_NAMES } from '../jobs/queues';
import { logger } from '../logger';
import { sendEmail } from '../mail';
import { redis } from '../redis';
import { clientHealth } from './health';
import { MARKET_AVAILABLE } from './marketplace';
import { notifyPermission, usersWithPermission } from './notifications';

/**
 * Super-admin alert rules, checked every 15 minutes by the worker. Each rule watches one metric
 * against a threshold; per-entity metrics (a client, a supplier, a request) alert once per entity
 * per cooldown. Alerts go to everyone with `marketplace.manage` (bell + optional email) and are kept
 * as history.
 */

export const alertRuleInput = z.object({
  name: z.string().trim().min(2).max(120),
  metric: z.enum(ALERT_METRIC_KEYS),
  threshold: z.number().min(0).max(1_000_000_000),
  params: z.object({ industry: z.string().trim().max(120).optional() }).default({}),
  cooldownHours: z.number().int().min(1).max(720).default(24),
  email: z.boolean().default(false),
  active: z.boolean().default(true),
});

const ser = <T extends { threshold: Prisma.Decimal }>(r: T) => ({ ...r, threshold: Number(r.threshold) });

export async function listAlertRules() {
  return withPlatform(async (tx) => {
    const [rules, events] = await Promise.all([
      tx.alertRule.findMany({ orderBy: { createdAt: 'asc' } }),
      tx.alertRuleEvent.findMany({ orderBy: { createdAt: 'desc' }, take: 100, include: { rule: { select: { name: true, metric: true } } } }),
    ]);
    return { rules: rules.map(ser), events: events.map((e) => ({ ...e, value: Number(e.value) })) };
  });
}

export async function saveAlertRule(ctx: AuthContext, id: string | null, input: z.infer<typeof alertRuleInput>) {
  return withPlatform(async (tx) => {
    if (id && !(await tx.alertRule.findUnique({ where: { id } }))) throw notFound('Alert rule');
    const data = { ...input, params: input.params as Prisma.InputJsonValue };
    const r = id ? await tx.alertRule.update({ where: { id }, data }) : await tx.alertRule.create({ data: { ...data, createdById: ctx.user.id } });
    await audit(tx, ctx, { action: id ? 'alert_rule.updated' : 'alert_rule.created', targetType: 'alert_rule', targetId: r.id, organizationId: null, after: { ...input } });
    return ser(r);
  });
}

export async function deleteAlertRule(ctx: AuthContext, id: string) {
  return withPlatform(async (tx) => {
    await tx.alertRule.delete({ where: { id } }).catch(() => { throw notFound('Alert rule'); });
    await audit(tx, ctx, { action: 'alert_rule.deleted', targetType: 'alert_rule', targetId: id, organizationId: null });
    return { ok: true };
  });
}

type Hit = { key: string; title: string; body: string; value: number; link: string };

/** What a rule currently sees: one hit per entity breaching the threshold. */
export async function measure(metric: AlertMetric, threshold: number, params: { industry?: string }): Promise<Hit[]> {
  switch (metric) {
    case 'client_credits_below': {
      const rows = await withPlatform((tx) => tx.creditWallet.findMany({ where: { balance: { lt: threshold }, lifetimeIn: { gt: 0 } }, take: 100 }));
      const orgs = await withPlatform((tx) => tx.organization.findMany({ where: { id: { in: rows.map((r) => r.organizationId) }, status: 'ACTIVE' }, select: { id: true, name: true } }));
      return orgs.map((o) => { const w = rows.find((r) => r.organizationId === o.id)!; return { key: o.id, title: `${o.name} is low on credits`, body: `${w.balance.toLocaleString()} credits left (alert below ${threshold.toLocaleString()}).`, value: w.balance, link: `/admin/organizations/${o.id}?tab=timeline` }; });
    }
    case 'stock_below': {
      const n = await withPlatform((tx) => tx.lead.count({ where: { AND: [MARKET_AVAILABLE, ...(params.industry ? [{ industry: { equals: params.industry, mode: 'insensitive' as const } }] : [])] } }));
      return n < threshold ? [{ key: params.industry ?? 'all', title: `${params.industry ? `${params.industry} stock` : 'Marketplace stock'} is low`, body: `${n.toLocaleString()} leads available (alert below ${threshold.toLocaleString()}).`, value: n, link: '/admin/insights?tab=inventory' }] : [];
    }
    case 'pending_request_hours': {
      const rows = await withPlatform((tx) => tx.leadRequest.findMany({ where: { status: 'PENDING', createdAt: { lt: new Date(Date.now() - threshold * 3_600_000) } }, select: { id: true, code: true, leadCount: true, createdAt: true }, take: 50 }));
      return rows.map((r) => ({ key: r.id, title: `Lead request ${r.code} is waiting`, body: `${r.leadCount} leads, waiting ${Math.round((Date.now() - r.createdAt.getTime()) / 3_600_000)}h.`, value: (Date.now() - r.createdAt.getTime()) / 3_600_000, link: '/admin/marketplace?tab=requests' }));
    }
    case 'pending_credit_hours': {
      const rows = await withPlatform((tx) => tx.creditRequest.findMany({ where: { status: { in: ['PENDING', 'AWAITING_PAYMENT'] }, createdAt: { lt: new Date(Date.now() - threshold * 3_600_000) } }, select: { id: true, code: true, total: true, currency: true, createdAt: true }, take: 50 }));
      return rows.map((r) => ({ key: r.id, title: `Credit request ${r.code} is waiting`, body: `${r.currency} ${Number(r.total).toFixed(2)}, waiting ${Math.round((Date.now() - r.createdAt.getTime()) / 3_600_000)}h.`, value: (Date.now() - r.createdAt.getTime()) / 3_600_000, link: '/admin/marketplace?tab=credits' }));
    }
    case 'supplier_report_rate': {
      const { supplierPerformance } = await import('./suppliers');
      const p = await supplierPerformance({ days: 30 });
      return p.suppliers.filter((s) => s.sold >= 10 && s.reportRate > threshold).map((s) => ({ key: s.id, title: `${s.name}: ${s.reportRate}% of sold leads reported`, body: `${s.disputes} reports on ${s.sold} sold leads in 30 days (alert above ${threshold}%).`, value: s.reportRate, link: '/admin/suppliers' }));
    }
    case 'client_health_below': {
      const h = await clientHealth();
      return h.filter((c) => c.score < threshold).map((c) => ({ key: c.organizationId, title: `${c.name} health dropped to ${c.score}`, body: c.reasons.filter((r) => r.tone === 'bad').map((r) => r.text).join(' · ') || 'Low engagement', value: c.score, link: `/admin/organizations/${c.organizationId}?tab=timeline` }));
    }
    case 'daily_revenue_below': {
      const start = new Date(); start.setHours(0, 0, 0, 0); const y = new Date(start.getTime() - 86400_000);
      const [a, b] = await withPlatform((tx) => Promise.all([
        tx.leadRequest.aggregate({ where: { paymentMethod: 'INVOICE', billingStatus: { in: ['DUE', 'PAID'] }, decidedAt: { gte: y, lt: start } }, _sum: { total: true } }),
        tx.creditRequest.aggregate({ where: { status: 'COMPLETED', paidAt: { gte: y, lt: start } }, _sum: { total: true } }),
      ]));
      const v = Number(a._sum.total ?? 0) + Number(b._sum.total ?? 0);
      return v < threshold ? [{ key: y.toISOString().slice(0, 10), title: 'Yesterday’s revenue was low', body: `${v.toFixed(2)} (alert below ${threshold}).`, value: v, link: '/admin/insights' }] : [];
    }
    case 'failed_jobs_above': {
      const counts = await Promise.all(QUEUE_NAMES.map((q) => queue(q).getJobCountByTypes('failed').catch(() => 0)));
      const v = counts.reduce((x, y) => x + y, 0);
      return v > threshold ? [{ key: 'jobs', title: `${v} failed background jobs`, body: `Above your limit of ${threshold}. Review them in System health.`, value: v, link: '/admin/system' }] : [];
    }
  }
  return [];
}

/** Worker: evaluate every active rule. */
export async function evaluateAlertRules() {
  const rules = await withPlatform((tx) => tx.alertRule.findMany({ where: { active: true } }));
  let fired = 0;
  for (const r of rules) {
    try {
      const hits = await measure(r.metric as AlertMetric, Number(r.threshold), (r.params ?? {}) as { industry?: string });
      for (const h of hits) {
        const ok = await redis().set(`alert:${r.id}:${h.key}`, '1', 'EX', r.cooldownHours * 3600, 'NX').catch(() => 'OK');
        if (ok !== 'OK') continue;
        await withPlatform((tx) => tx.alertRuleEvent.create({ data: { ruleId: r.id, title: h.title, body: h.body, value: h.value } }));
        await notifyPermission('marketplace.manage', null, { type: 'ALERT_RULE', title: h.title, body: `${r.name}: ${h.body}`, link: h.link });
        if (r.email) {
          const ids = await usersWithPermission('marketplace.manage', null);
          const users = await withPlatform((tx) => tx.user.findMany({ where: { id: { in: ids }, status: 'ACTIVE' }, select: { email: true } }));
          for (const u of users) await sendEmail({ to: u.email, subject: `Alert: ${h.title}`, body: `${h.body}\n\nRule: ${r.name}\n${process.env.APP_URL ?? ''}${h.link}` }).catch(() => null);
        }
        fired++;
      }
      if (hits.length) await withPlatform((tx) => tx.alertRule.update({ where: { id: r.id }, data: { lastFiredAt: new Date() } }));
    } catch (err) {
      logger.warn({ err, rule: r.id }, 'alert rule evaluation failed');
    }
  }
  return { rules: rules.length, fired };
}
