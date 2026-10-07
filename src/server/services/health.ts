import { withPlatform } from '../db';
import { getCreditSettings } from './credits';

/**
 * Client health: a 0–100 score per workspace from the last 30 days, with the reasons behind it.
 *  - Engagement (30): share of members who signed in in the last 14 days, plus contact activity.
 *  - Lead handling (30): speed to first contact and the backlog of leads waiting > 3 days.
 *  - Buying (25): purchases this month vs the month before.
 *  - Satisfaction (15): quality-report rate.
 * Status: healthy ≥ 70, watch 40–69, at risk < 40. "Ready to grow" = buying more, working leads fast and low on credits.
 */

export type Health = {
  organizationId: string; name: string; score: number; status: 'healthy' | 'watch' | 'at_risk'; expansion: boolean;
  reasons: { tone: 'good' | 'bad'; text: string }[];
  metrics: { members: number; activeMembers: number; comms14d: number; leads30d: number; medianHoursToContact: number | null; backlog: number; purchases30d: number; purchasesPrev30d: number; spend30d: number; reports30d: number; delivered30d: number; credits: number; creditDaysLeft: number | null };
};

const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const map = <T extends { organizationId: string | null }>(rows: T[]) => new Map(rows.filter((r) => r.organizationId).map((r) => [r.organizationId!, r]));

export async function clientHealth(opts: { organizationId?: string } = {}): Promise<Health[]> {
  const now = Date.now();
  const d14 = new Date(now - 14 * 86400_000), d30 = new Date(now - 30 * 86400_000), d60 = new Date(now - 60 * 86400_000), d3 = new Date(now - 3 * 86400_000);
  const cs = await getCreditSettings();
  return withPlatform(async (tx) => {
    const orgs = await tx.organization.findMany({ where: { status: 'ACTIVE', ...(opts.organizationId ? { id: opts.organizationId } : {}) }, select: { id: true, name: true }, take: 1000 });
    const ids = orgs.map((o) => o.id);
    const [members, active, comms, leads, backlog, req30, reqPrev, reports, delivered, wallets, spend30] = await Promise.all([
      tx.membership.groupBy({ by: ['organizationId'], where: { organizationId: { in: ids }, user: { status: 'ACTIVE' } }, _count: true }),
      tx.$queryRaw<{ organizationId: string; c: number }[]>`
        SELECT m."organizationId", COUNT(DISTINCT m."userId")::int AS c FROM memberships m JOIN login_events e ON e."userId" = m."userId"
        WHERE e.success AND e."createdAt" >= ${d14} AND m."organizationId" = ANY(${ids}::text[]) GROUP BY 1`,
      tx.communicationLog.groupBy({ by: ['organizationId'], where: { organizationId: { in: ids }, occurredAt: { gte: d14 } }, _count: true }),
      tx.clientLead.findMany({ where: { organizationId: { in: ids }, createdAt: { gte: d30 }, revokedAt: null }, select: { organizationId: true, createdAt: true, firstContactAt: true }, take: 50_000 }),
      tx.clientLead.groupBy({ by: ['organizationId'], where: { organizationId: { in: ids }, revokedAt: null, archivedAt: null, firstContactAt: null, status: { notIn: ['CONVERTED', 'LOST'] }, createdAt: { lt: d3 } }, _count: true }),
      tx.leadRequest.groupBy({ by: ['organizationId'], where: { organizationId: { in: ids }, createdAt: { gte: d30 }, status: { in: ['PENDING', 'FULFILLED', 'PARTIAL'] } }, _count: true, _sum: { total: true } }),
      tx.leadRequest.groupBy({ by: ['organizationId'], where: { organizationId: { in: ids }, createdAt: { gte: d60, lt: d30 }, status: { in: ['PENDING', 'FULFILLED', 'PARTIAL'] } }, _count: true }),
      tx.leadDispute.groupBy({ by: ['organizationId'], where: { organizationId: { in: ids }, createdAt: { gte: d30 } }, _count: true }),
      tx.leadRequestItem.groupBy({ by: ['organizationId'], where: { organizationId: { in: ids }, status: 'DELIVERED', free: false, request: { decidedAt: { gte: d30 } } }, _count: true }),
      tx.creditWallet.findMany({ where: { organizationId: { in: ids } }, select: { organizationId: true, balance: true, lifetimeIn: true } }),
      tx.creditEntry.groupBy({ by: ['organizationId'], where: { organizationId: { in: ids }, type: 'SPEND', createdAt: { gte: d30 } }, _sum: { credits: true } }),
    ]);
    const M = { members: map(members), active: map(active), comms: map(comms), backlog: map(backlog), req30: map(req30), reqPrev: map(reqPrev), reports: map(reports), delivered: map(delivered), wallets: map(wallets), spend: map(spend30) };
    const leadsBy = new Map<string, typeof leads>();
    for (const l of leads) leadsBy.set(l.organizationId, [...(leadsBy.get(l.organizationId) ?? []), l]);

    return orgs.map((o) => {
      const m = M.members.get(o.id)?._count ?? 0;
      const a = M.active.get(o.id)?.c ?? 0;
      const c14 = M.comms.get(o.id)?._count ?? 0;
      const ls = leadsBy.get(o.id) ?? [];
      const hrs = ls.filter((l) => l.firstContactAt).map((l) => (l.firstContactAt!.getTime() - l.createdAt.getTime()) / 3_600_000).filter((h) => h >= 0);
      const med = median(hrs);
      const back = M.backlog.get(o.id)?._count ?? 0;
      const p30 = M.req30.get(o.id)?._count ?? 0;
      const pPrev = M.reqPrev.get(o.id)?._count ?? 0;
      const rep = M.reports.get(o.id)?._count ?? 0;
      const del = M.delivered.get(o.id)?._count ?? 0;
      const w = M.wallets.get(o.id);
      const spent30 = -(M.spend.get(o.id)?._sum.credits ?? 0);
      const daysLeft = w && spent30 > 0 ? Math.round(w.balance / (spent30 / 30)) : null;
      const reasons: Health['reasons'] = [];

      // Engagement (30)
      const loginShare = m ? a / m : 0;
      let eng = Math.round(loginShare * 20) + Math.min(10, Math.round(c14 / 5));
      if (a === 0) reasons.push({ tone: 'bad', text: 'Nobody has signed in for 14 days' });
      else if (loginShare >= 0.6) reasons.push({ tone: 'good', text: `${a} of ${m} members active` });
      if (c14 === 0 && ls.length) { reasons.push({ tone: 'bad', text: 'No calls or messages logged in 14 days' }); eng = Math.min(eng, 10); }

      // Lead handling (30)
      let handling = 15;
      if (med != null) handling = med <= 4 ? 22 : med <= 24 ? 18 : med <= 72 ? 10 : 4;
      const backShare = ls.length ? back / Math.max(ls.length, back) : back > 0 ? 1 : 0;
      handling += backShare < 0.1 ? 8 : backShare < 0.3 ? 4 : 0;
      if (med != null && med <= 24) reasons.push({ tone: 'good', text: `Contacts new leads in ${med < 1 ? 'under an hour' : `${Math.round(med)}h`}` });
      if (med != null && med > 72) reasons.push({ tone: 'bad', text: `Slow follow-up: ${Math.round(med / 24)} days to first contact` });
      if (back >= 10) reasons.push({ tone: 'bad', text: `${back} leads waiting over 3 days for first contact` });

      // Buying (25)
      let buying = p30 === 0 && pPrev === 0 ? 8 : p30 >= pPrev ? 25 : Math.round((p30 / Math.max(1, pPrev)) * 20);
      if (p30 > pPrev && p30 > 0) reasons.push({ tone: 'good', text: `Buying more: ${p30} requests vs ${pPrev} last month` });
      if (pPrev > 0 && p30 === 0) { reasons.push({ tone: 'bad', text: 'Stopped buying this month' }); buying = 0; }

      // Satisfaction (15)
      const reportRate = del ? rep / del : 0;
      const sat = reportRate > 0.2 ? 0 : reportRate > 0.1 ? 7 : 15;
      if (reportRate > 0.1) reasons.push({ tone: 'bad', text: `${Math.round(reportRate * 100)}% of purchased leads reported` });

      const score = Math.max(0, Math.min(100, eng + handling + buying + sat));
      const status: Health['status'] = score >= 70 ? 'healthy' : score >= 40 ? 'watch' : 'at_risk';
      const expansion = p30 > pPrev && p30 >= 2 && (med == null || med <= 24) && (daysLeft != null ? daysLeft <= 14 : (w?.balance ?? 0) * cs.creditValue < 1000);
      if (expansion) reasons.push({ tone: 'good', text: daysLeft != null ? `Credits run out in ~${daysLeft} days — good time to offer a bigger pack` : 'Growing fast — offer a bigger credit pack' });
      return {
        organizationId: o.id, name: o.name, score, status, expansion, reasons: reasons.slice(0, 5),
        metrics: { members: m, activeMembers: a, comms14d: c14, leads30d: ls.length, medianHoursToContact: med == null ? null : Math.round(med * 10) / 10, backlog: back, purchases30d: p30, purchasesPrev30d: pPrev, spend30d: Number(M.req30.get(o.id)?._sum.total ?? 0), reports30d: rep, delivered30d: del, credits: w?.balance ?? 0, creditDaysLeft: daysLeft },
      };
    }).sort((x, y) => x.score - y.score);
  });
}

// ── Account timeline ───────────────────────────────────────────────

export type TimelineItem = { at: Date; kind: 'audit' | 'login' | 'credits' | 'invoice'; title: string; detail: string | null; actor: string | null; tone: 'neutral' | 'good' | 'bad' | 'money' };

const AUDIT_LABEL: Record<string, string> = {
  'marketplace.request.created': 'Requested leads', 'marketplace.request.fulfilled': 'Lead request delivered', 'marketplace.request.rejected': 'Lead request declined', 'marketplace.request.cancelled': 'Lead request cancelled',
  'marketplace.billing.updated': 'Billing status changed', 'credits.request.created': 'Requested credits', 'credits.request.completed': 'Credit purchase completed', 'credits.request.rejected': 'Credit request declined',
  'credits.adjusted': 'Credits adjusted', 'marketplace.dispute.reported': 'Reported a lead', 'marketplace.dispute.approved': 'Lead report approved', 'marketplace.dispute.rejected': 'Lead report rejected',
  'marketplace.search.saved': 'Saved a search', 'workspace.automation.updated': 'Changed automation settings', 'org.created': 'Workspace created', 'org.updated': 'Workspace updated',
};

/** Everything that happened with one client, newest first. */
export async function orgTimeline(orgId: string, opts: { before?: Date; limit?: number } = {}) {
  const limit = Math.min(opts.limit ?? 60, 200);
  const before = opts.before ?? new Date(Date.now() + 1000);
  return withPlatform(async (tx) => {
    const memberIds = (await tx.membership.findMany({ where: { organizationId: orgId }, select: { userId: true } })).map((m) => m.userId);
    const [auditRows, logins, credits, invoices] = await Promise.all([
      tx.auditEvent.findMany({ where: { organizationId: orgId, createdAt: { lt: before }, NOT: { action: { startsWith: 'auth.' } } }, orderBy: { createdAt: 'desc' }, take: limit, select: { action: true, actorEmail: true, createdAt: true, metadata: true, reason: true, result: true } }),
      tx.loginEvent.findMany({ where: { userId: { in: memberIds }, createdAt: { lt: before } }, orderBy: { createdAt: 'desc' }, take: limit, select: { email: true, success: true, createdAt: true, ip: true } }),
      tx.creditEntry.findMany({ where: { organizationId: orgId, createdAt: { lt: before } }, orderBy: { createdAt: 'desc' }, take: limit, select: { type: true, credits: true, balanceAfter: true, note: true, createdAt: true } }),
      tx.taxInvoice.findMany({ where: { organizationId: orgId, issuedAt: { lt: before } }, orderBy: { issuedAt: 'desc' }, take: limit, select: { number: true, total: true, currency: true, kind: true, issuedAt: true } }),
    ]);
    const items: TimelineItem[] = [
      ...auditRows.map((a) => {
        const m = (a.metadata ?? {}) as Record<string, unknown>;
        const detail = [m.code, m.leads != null ? `${m.leads} leads` : null, m.total ? `total ${m.total}` : null, m.credits != null ? `${m.credits} credits` : null, a.reason].filter(Boolean).join(' · ') || null;
        return { at: a.createdAt, kind: 'audit' as const, title: AUDIT_LABEL[a.action] ?? a.action.replace(/[._]/g, ' '), detail, actor: a.actorEmail, tone: (a.result === 'SUCCESS' ? (/rejected|declined|cancel/.test(a.action) ? 'bad' : 'neutral') : 'bad') as TimelineItem['tone'] };
      }),
      ...logins.map((l) => ({ at: l.createdAt, kind: 'login' as const, title: l.success ? 'Signed in' : 'Failed sign-in', detail: l.ip, actor: l.email, tone: (l.success ? 'neutral' : 'bad') as TimelineItem['tone'] })),
      ...credits.map((c) => ({ at: c.createdAt, kind: 'credits' as const, title: `${c.credits > 0 ? '+' : ''}${c.credits.toLocaleString()} credits · ${c.type.toLowerCase()}`, detail: `${c.note ?? ''}${c.note ? ' · ' : ''}balance ${c.balanceAfter.toLocaleString()}`, actor: null, tone: (c.credits > 0 ? 'good' : 'neutral') as TimelineItem['tone'] })),
      ...invoices.map((i) => ({ at: i.issuedAt, kind: 'invoice' as const, title: `Invoice ${i.number}`, detail: `${i.kind === 'CREDIT_PURCHASE' ? 'Credit purchase' : 'Lead purchase'} · ${i.currency} ${Number(i.total).toFixed(2)}`, actor: null, tone: 'money' as const })),
    ].sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
    return { items, next: items.length === limit ? items[items.length - 1].at.toISOString() : null };
  });
}
