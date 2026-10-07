import type { AuthContext } from '../auth/context';
import { can } from '../auth/context';
import { withPlatform, withTenant } from '../db';
import { logger } from '../logger';
import { sendEmail } from '../mail';
import { getCreditSettings } from './credits';
import { getPricing } from './marketplace';
import { usersWithPermission } from './notifications';
import { orgSettings } from './organizations';
import { getGrowth } from './saved-searches';

/**
 * Lead ROI: what a workspace spent on leads, how fast it worked them and what they turned into —
 * overall, by industry, by monthly cohort and by rep. Spend = invoiced amounts + credits spent × credit value.
 */

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);

export async function roiDashboard(ctx: AuthContext, params: { days: number }) {
  const orgId = ctx.orgId!;
  const since = new Date(Date.now() - params.days * 86400_000);
  const [p, cs, org] = await Promise.all([getPricing(), getCreditSettings(), withPlatform((tx) => tx.organization.findUniqueOrThrow({ where: { id: orgId }, select: { settings: true } }))]);
  const sla = orgSettings(org.settings).workflows.firstContactSlaHours;
  const ownerOnly = can(ctx, 'crm.leads.read_all') ? null : ctx.user.id;

  const [requests, leads] = await Promise.all([
    withPlatform((tx) => tx.leadRequest.findMany({ where: { organizationId: orgId, createdAt: { gte: since }, status: { in: ['FULFILLED', 'PARTIAL'] } }, select: { total: true, tax: true, creditsCharged: true, paymentMethod: true, billingStatus: true, deliveredCount: true, freeApplied: true, decidedAt: true } })),
    withTenant(orgId, (tx) => tx.clientLead.findMany({
      where: { organizationId: orgId, revokedAt: null, createdAt: { gte: since }, ...(ownerOnly ? { ownerId: ownerOnly } : {}) },
      select: { id: true, createdAt: true, firstContactAt: true, status: true, dealValue: true, currency: true, industry: true, ownerId: true, owner: { select: { name: true } }, convertedAt: true },
      take: 20_000,
    })),
  ]);

  const moneySpend = requests.filter((r) => r.paymentMethod !== 'CREDITS' && ['DUE', 'PAID'].includes(r.billingStatus)).reduce((a, r) => a + Number(r.total), 0);
  const creditsSpent = requests.filter((r) => r.paymentMethod === 'CREDITS').reduce((a, r) => a + r.creditsCharged, 0);
  const spend = moneySpend + creditsSpent * cs.creditValue;
  const purchased = requests.reduce((a, r) => a + r.deliveredCount, 0);
  const free = requests.reduce((a, r) => a + r.freeApplied, 0);

  const contactHours = leads.filter((l) => l.firstContactAt).map((l) => (l.firstContactAt!.getTime() - l.createdAt.getTime()) / 3_600_000).filter((h) => h >= 0);
  const won = leads.filter((l) => l.status === 'CONVERTED');
  const revenue = won.reduce((a, l) => a + Number(l.dealValue ?? 0), 0);
  const qualified = leads.filter((l) => ['QUALIFIED', 'NEGOTIATION', 'CONVERTED'].includes(l.status)).length;
  const open = leads.filter((l) => !['CONVERTED', 'LOST'].includes(l.status));
  const uncontacted = leads.filter((l) => !l.firstContactAt && !['CONVERTED', 'LOST'].includes(l.status));
  const ageH = (l: { createdAt: Date }) => (Date.now() - l.createdAt.getTime()) / 3_600_000;

  const group = <K extends string>(key: (l: (typeof leads)[number]) => K) => {
    const m = new Map<K, typeof leads>();
    for (const l of leads) m.set(key(l), [...(m.get(key(l)) ?? []), l]);
    return [...m.entries()].map(([k, ls]) => {
      const w = ls.filter((l) => l.status === 'CONVERTED');
      const hrs = ls.filter((l) => l.firstContactAt).map((l) => (l.firstContactAt!.getTime() - l.createdAt.getTime()) / 3_600_000);
      return { key: k, leads: ls.length, contacted: ls.filter((l) => l.firstContactAt).length, won: w.length, revenue: w.reduce((a, l) => a + Number(l.dealValue ?? 0), 0), medianHoursToContact: median(hrs), winRate: pct(w.length, ls.length) };
    }).sort((a, b) => b.leads - a.leads);
  };

  const months = new Map<string, { month: string; leads: number; contacted: number; won: number; revenue: number }>();
  for (let i = Math.min(11, Math.ceil(params.days / 30)); i >= 0; i--) {
    const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - i);
    const k = d.toISOString().slice(0, 7);
    months.set(k, { month: k, leads: 0, contacted: 0, won: 0, revenue: 0 });
  }
  for (const l of leads) {
    const m = months.get(l.createdAt.toISOString().slice(0, 7));
    if (!m) continue;
    m.leads++; if (l.firstContactAt) m.contacted++;
    if (l.status === 'CONVERTED') { m.won++; m.revenue += Number(l.dealValue ?? 0); }
  }

  return {
    days: params.days, currency: p.currency, dealCurrency: won[0]?.currency ?? p.currency, slaHours: sla, scopedToMe: Boolean(ownerOnly),
    spend: { total: Math.round(spend * 100) / 100, invoiced: Math.round(moneySpend * 100) / 100, credits: creditsSpent, creditValue: cs.creditValue },
    funnel: { leads: leads.length, purchased, free, contacted: contactHours.length, qualified, won: won.length, lost: leads.filter((l) => l.status === 'LOST').length },
    rates: { contactRate: pct(contactHours.length, leads.length), qualifyRate: pct(qualified, leads.length), winRate: pct(won.length, leads.length) },
    value: {
      revenue, pipeline: open.reduce((a, l) => a + Number(l.dealValue ?? 0), 0),
      roi: spend > 0 ? Math.round((revenue / spend) * 100) / 100 : null,
      costPerLead: purchased && spend > 0 ? Math.round((spend / purchased) * 100) / 100 : null,
      costPerWin: won.length && spend > 0 ? Math.round((spend / won.length) * 100) / 100 : null,
    },
    speed: {
      medianHours: median(contactHours), withinSlaPct: pct(contactHours.filter((h) => h <= sla).length, contactHours.length),
      uncontacted: { total: uncontacted.length, under24h: uncontacted.filter((l) => ageH(l) < 24).length, d1to3: uncontacted.filter((l) => ageH(l) >= 24 && ageH(l) < 72).length, over3d: uncontacted.filter((l) => ageH(l) >= 72).length },
    },
    byIndustry: group((l) => l.industry ?? 'Other').slice(0, 12),
    byRep: ownerOnly ? [] : group((l) => (l.ownerId ? `${l.ownerId}|${l.owner?.name ?? 'Member'}` : '|Unassigned')).map((r) => ({ ...r, key: r.key.split('|')[1] })),
    byMonth: [...months.values()],
  };
}

// ── Weekly report email ────────────────────────────────────────────

const fmt = (n: number, cur: string) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(n);

/** Worker (Mondays): last week's numbers to each workspace's admins. */
export async function sendWeeklyReports() {
  const g = await getGrowth();
  if (!g.weeklyReport.enabled) return { sent: 0 };
  const orgs = await withPlatform((tx) => tx.organization.findMany({ where: { status: 'ACTIVE' }, select: { id: true, name: true } }));
  let sent = 0;
  for (const o of orgs) {
    try {
      const recipients = await usersWithPermission('crm.settings.manage', o.id);
      if (!recipients.length) continue;
      const users = await withPlatform((tx) => tx.user.findMany({ where: { id: { in: recipients }, status: 'ACTIVE' }, select: { id: true, email: true, name: true } }));
      const ctx = { user: { id: users[0]?.id ?? '', email: '', name: '', mfaEnabled: false }, orgId: o.id, scope: 'ORGANIZATION', permissions: new Set(['crm.leads.read_all']) } as unknown as AuthContext;
      const r = await roiDashboard(ctx, { days: 7 });
      if (!r.funnel.leads && !r.funnel.won && !r.speed.uncontacted.total) continue;
      const lines = [
        `Here's how ${o.name} did in the last 7 days:`, '',
        `• New leads: ${r.funnel.leads} (${r.funnel.purchased} purchased, ${r.funnel.free} free)`,
        `• Contacted: ${r.funnel.contacted} (${r.rates.contactRate}%) — median ${r.speed.medianHours == null ? '—' : `${Math.round(r.speed.medianHours)}h`} to first contact, ${r.speed.withinSlaPct}% within your ${r.slaHours}h target`,
        `• Won: ${r.funnel.won} deal${r.funnel.won === 1 ? '' : 's'} worth ${fmt(r.value.revenue, r.dealCurrency)}`,
        `• Spent on leads: ${fmt(r.spend.total, r.currency)}${r.value.roi != null ? ` — ${r.value.roi}× return` : ''}`,
        r.speed.uncontacted.total ? `• Waiting for first contact: ${r.speed.uncontacted.total} (${r.speed.uncontacted.over3d} for over 3 days)` : null,
        '', `Open your dashboard: ${process.env.APP_URL ?? ''}/app/roi`,
      ].filter((x) => x !== null).join('\n');
      for (const u of users) { await sendEmail({ to: u.email, subject: `${o.name} — your weekly lead report`, body: lines }); sent++; }
    } catch (err) {
      logger.warn({ err, org: o.id }, 'weekly report failed');
    }
  }
  return { sent };
}
