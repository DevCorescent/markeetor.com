import { randomBytes } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import type { LeadEnrichment, Prisma } from '@prisma/client';
import { cleanCompanyName } from '@/lib/business';
import { aiStatus } from '../ai';
import { can, type AuthContext } from '../auth/context';
import { withPlatform, withTenant } from '../db';
import { logger } from '../logger';
import { visibleLead } from './crm';
import { grantCredits } from './credits';
import { notifyPermission } from './notifications';
import { orgSettings } from './organizations';
import { getGrowth } from './saved-searches';

/**
 * Client productivity tools: the "Today" queue, the AI lead assistant (next best action + message drafts),
 * the getting-started checklist and referrals.
 */

// ── Today queue ────────────────────────────────────────────────────

const LEAD_SELECT = { id: true, fullName: true, company: true, jobTitle: true, city: true, country: true, industry: true, score: true, status: true, createdAt: true, nextFollowUpAt: true, lastActivityAt: true, firstContactAt: true, owner: { select: { id: true, name: true } } } satisfies Prisma.ClientLeadSelect;

export async function todayQueue(ctx: AuthContext, opts: { mine?: boolean } = {}) {
  const orgId = ctx.orgId!;
  const onlyMine = opts.mine || !can(ctx, 'crm.leads.read_all');
  const org = await withPlatform((tx) => tx.organization.findUniqueOrThrow({ where: { id: orgId }, select: { settings: true } }));
  const wf = orgSettings(org.settings).workflows;
  const now = new Date();
  const endOfDay = new Date(now); endOfDay.setHours(23, 59, 59, 999);
  const stale = new Date(Date.now() - wf.staleLeadDays * 86400_000);
  const base: Prisma.ClientLeadWhereInput = { organizationId: orgId, revokedAt: null, archivedAt: null, status: { notIn: ['CONVERTED', 'LOST'] }, ...(onlyMine ? { ownerId: ctx.user.id } : {}) };
  return withTenant(orgId, async (tx) => {
    const [overdue, dueToday, uncontacted, staleLeads, tasks] = await Promise.all([
      tx.clientLead.findMany({ where: { ...base, nextFollowUpAt: { lt: now } }, select: LEAD_SELECT, orderBy: { nextFollowUpAt: 'asc' }, take: 50 }),
      tx.clientLead.findMany({ where: { ...base, nextFollowUpAt: { gte: now, lte: endOfDay } }, select: LEAD_SELECT, orderBy: { nextFollowUpAt: 'asc' }, take: 50 }),
      // Speed-to-lead: never contacted, best first, oldest first within a score.
      tx.clientLead.findMany({ where: { ...base, firstContactAt: null }, select: LEAD_SELECT, orderBy: [{ score: 'desc' }, { createdAt: 'asc' }], take: 50 }),
      tx.clientLead.findMany({ where: { ...base, firstContactAt: { not: null }, nextFollowUpAt: null, OR: [{ lastActivityAt: { lt: stale } }, { lastActivityAt: null }] }, select: LEAD_SELECT, orderBy: { lastActivityAt: 'asc' }, take: 50 }),
      tx.task.findMany({
        where: { organizationId: orgId, status: { in: ['OPEN', 'IN_PROGRESS'] }, dueAt: { lte: endOfDay }, ...(onlyMine ? { assigneeId: ctx.user.id } : {}) },
        select: { id: true, title: true, type: true, priority: true, dueAt: true, clientLeadId: true, clientLead: { select: { fullName: true, company: true } }, assignee: { select: { name: true } } },
        orderBy: { dueAt: 'asc' }, take: 50,
      }),
    ]);
    const hoursWaiting = (d: Date) => Math.round((Date.now() - d.getTime()) / 3_600_000);
    return {
      slaHours: wf.firstContactSlaHours, staleDays: wf.staleLeadDays, scope: onlyMine ? 'mine' : 'team',
      counts: { overdue: overdue.length, dueToday: dueToday.length, uncontacted: uncontacted.length, stale: staleLeads.length, tasks: tasks.length },
      overdue, dueToday, stale: staleLeads, tasks,
      uncontacted: uncontacted.map((l) => ({ ...l, hoursWaiting: hoursWaiting(l.createdAt), breached: hoursWaiting(l.createdAt) > wf.firstContactSlaHours })),
    };
  });
}

// ── AI lead assistant ──────────────────────────────────────────────

type Action = { title: string; why: string; channel: 'CALL' | 'WHATSAPP' | 'EMAIL' | 'TASK' | 'STATUS'; urgency: 'now' | 'today' | 'soon' };

function companyFacts(e: LeadEnrichment | null) {
  if (!e || (e.status !== 'DONE' && e.status !== 'PARTIAL')) return null;
  const d = (e.data ?? {}) as Record<string, { value: unknown; confidence: number } | undefined>;
  const v = (k: string, min = 60) => (d[k] && d[k]!.confidence >= min ? d[k]!.value : null);
  return { description: v('description') as string | null, specialty: v('subIndustry') as string | null, size: v('companySize') as string | null, keywords: (v('keywords', 55) as string[] | null) ?? [] };
}

/** Rule-based next best action from where the lead is in the process. */
function nextActions(l: { status: string; firstContactAt: Date | null; nextFollowUpAt: Date | null; lastActivityAt: Date | null; createdAt: Date; hasPhone: boolean; hasEmail: boolean }, comms: { channel: string; outcome: string; occurredAt: Date }[], slaHours: number): Action[] {
  const out: Action[] = [];
  const h = (d: Date) => (Date.now() - d.getTime()) / 3_600_000;
  if (l.status === 'CONVERTED') return [{ title: 'Ask for a referral or a review', why: 'Happy new customers are the best source of the next deal — ask while the win is fresh.', channel: l.hasPhone ? 'CALL' : 'EMAIL', urgency: 'soon' }];
  if (l.status === 'LOST') return [{ title: 'Set a reminder to re-engage', why: 'Timing changes. A short check-in in 60–90 days often reopens lost deals.', channel: 'TASK', urgency: 'soon' }];
  const last = comms[0];
  if (!l.firstContactAt) {
    const waited = h(l.createdAt);
    out.push({ title: l.hasPhone ? 'Call now — first contact' : 'Send a first email', why: `Leads contacted within an hour convert far better. This one has waited ${waited < 1 ? 'under an hour' : `${Math.round(waited)}h`}${waited > slaHours ? ` — past your ${slaHours}h target` : ''}.`, channel: l.hasPhone ? 'CALL' : 'EMAIL', urgency: 'now' });
    if (l.hasPhone) out.push({ title: 'Follow with a WhatsApp intro', why: 'If the call goes unanswered, a short WhatsApp message gets a much higher response rate than voicemail.', channel: 'WHATSAPP', urgency: 'today' });
  } else if (last && ['NO_ANSWER', 'VOICEMAIL', 'BUSY'].includes(last.outcome)) {
    const tries = comms.filter((c) => c.channel === 'CALL' && ['NO_ANSWER', 'VOICEMAIL', 'BUSY'].includes(c.outcome)).length;
    out.push(tries >= 3
      ? { title: 'Switch channel — try email or WhatsApp', why: `${tries} calls without an answer. Change channel and time of day.`, channel: l.hasEmail ? 'EMAIL' : 'WHATSAPP', urgency: 'today' }
      : { title: 'Call again at a different time', why: `The last call (${last.outcome.toLowerCase().replace('_', ' ')}) was ${Math.round(h(last.occurredAt))}h ago. Try a different time slot.`, channel: 'CALL', urgency: 'today' });
  } else if (l.status === 'CONTACTED') {
    out.push({ title: 'Qualify: need, budget, timeline', why: 'You have spoken — confirm the need, budget and decision timeline, then move the lead to Qualified.', channel: 'CALL', urgency: 'soon' });
  } else if (l.status === 'QUALIFIED') {
    out.push({ title: 'Send a proposal and book the next meeting', why: 'Qualified leads stall without a clear next step on the calendar.', channel: 'EMAIL', urgency: 'soon' });
  } else if (l.status === 'NEGOTIATION') {
    out.push({ title: 'Close: confirm terms and the decision date', why: 'Keep momentum — agree the final terms and the date they will decide.', channel: 'CALL', urgency: 'today' });
  }
  if (l.nextFollowUpAt && l.nextFollowUpAt < new Date()) out.unshift({ title: 'Overdue follow-up', why: `The follow-up was due ${Math.round(h(l.nextFollowUpAt))}h ago.`, channel: l.hasPhone ? 'CALL' : 'EMAIL', urgency: 'now' });
  if (!l.nextFollowUpAt && l.firstContactAt) out.push({ title: 'Schedule the next follow-up', why: 'Leads without a scheduled next step go cold. Put one on the calendar.', channel: 'TASK', urgency: 'soon' });
  return out.slice(0, 3);
}

/** Plain, safe templates (used when AI is off). Only the name, company and industry are used — never raw research text. */
function templateDraft(kind: 'intro' | 'followup' | 'whatsapp', x: { first: string; company: string | null; industry: string | null; sender: string; org: string }) {
  const hi = `Hi ${x.first},`;
  const who = x.company ?? 'your team';
  const peers = x.industry ? `${x.industry.toLowerCase()} businesses` : 'businesses like yours';
  if (kind === 'whatsapp') return { subject: null, body: `${hi} this is ${x.sender} from ${x.org}. We help ${peers} win more customers, and I thought it could be useful for ${who}. Would a quick 10-minute call this week work for you?` };
  if (kind === 'followup') return { subject: `Following up${x.company ? ` — ${x.company}` : ''}`, body: `${hi}\n\nI wanted to follow up on my earlier message. If now isn't the right time, just let me know and I'll check back later.\n\nWould a short call on Tuesday or Thursday work for you?\n\nBest regards,\n${x.sender}\n${x.org}` };
  return { subject: `Quick question${x.company ? ` for ${x.company}` : ''}`, body: `${hi}\n\nI'm ${x.sender} from ${x.org}. We work with ${peers} to help them win more customers, and I'd love to learn how ${who} handles this today.\n\nWould you be open to a 15-minute call this week to see if it's a fit?\n\nBest regards,\n${x.sender}\n${x.org}` };
}

export async function leadAssistant(ctx: AuthContext, clientLeadId: string, opts: { draft?: 'intro' | 'followup' | 'whatsapp' } = {}) {
  const orgId = ctx.orgId!;
  const cl = await withTenant(orgId, (tx) => visibleLead(tx, ctx, clientLeadId));
  const [comms, e, org] = await Promise.all([
    withTenant(orgId, (tx) => tx.communicationLog.findMany({ where: { clientLeadId }, orderBy: { occurredAt: 'desc' }, take: 10, select: { channel: true, outcome: true, occurredAt: true, body: true } })),
    withPlatform((tx) => tx.leadEnrichment.findUnique({ where: { leadId: cl.leadId } })),
    withPlatform((tx) => tx.organization.findUniqueOrThrow({ where: { id: orgId }, select: { name: true, settings: true } })),
  ]);
  const sla = orgSettings(org.settings).workflows.firstContactSlaHours;
  const actions = nextActions({ ...cl, hasPhone: Boolean(cl.phone), hasEmail: Boolean(cl.email) }, comms, sla);
  const f = companyFacts(e);
  const company = cleanCompanyName(cl.company) ?? cl.company;
  const x = { first: cl.fullName.split(/\s+/)[0] ?? cl.fullName, company, industry: cl.industry, sender: ctx.user.name, org: org.name };
  if (!opts.draft) return { actions, company: f, engine: 'rules' as const };

  let draft = templateDraft(opts.draft, x);
  let engine: 'claude' | 'template' = 'template';
  const ai = await aiStatus();
  // Only the first name, company facts and history summary are sent — never contact details.
  if (ai.enabled && ai.egressAllowed && process.env.AI_PROVIDER_API_KEY) {
    try {
      const client = new Anthropic({ apiKey: process.env.AI_PROVIDER_API_KEY });
      const brief = {
        firstName: x.first, jobTitle: cl.jobTitle, company, industry: cl.industry, location: [cl.city, cl.country].filter(Boolean).join(', ') || null,
        companyProfile: f, status: cl.status, previousContacts: comms.slice(0, 5).map((c) => ({ channel: c.channel, outcome: c.outcome, when: c.occurredAt.toISOString().slice(0, 10) })),
        sender: { name: x.sender, company: x.org },
      };
      const kind = opts.draft === 'intro' ? 'a first outreach email' : opts.draft === 'followup' ? 'a short follow-up email' : 'a short WhatsApp message (max 60 words, no subject)';
      const res = await client.messages.create({
        model: process.env.AI_MODEL || 'claude-opus-5-5', max_tokens: 600,
        system: 'You write concise, personable B2B sales outreach. Personalise using the company profile when available, never invent facts, no buzzwords, one clear call to action. Return JSON only: {"subject": string|null, "body": string}.',
        messages: [{ role: 'user', content: `Write ${kind} to this prospect.\n${JSON.stringify(brief)}` }],
      });
      const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('');
      const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as { subject?: string | null; body?: string };
      if (json.body) { draft = { subject: opts.draft === 'whatsapp' ? null : json.subject ?? draft.subject, body: json.body.slice(0, 4000) }; engine = 'claude'; }
    } catch (err) {
      logger.warn({ err }, 'lead assistant: AI draft failed, using template');
    }
  }
  return { actions, company: f, draft, engine };
}

// ── Getting-started checklist ──────────────────────────────────────

export async function onboardingChecklist(ctx: AuthContext) {
  const orgId = ctx.orgId!;
  const [requests, members, contacted, searches, wallet, creditReqs, org] = await Promise.all([
    withPlatform((tx) => tx.leadRequest.count({ where: { organizationId: orgId } })),
    withPlatform((tx) => tx.membership.count({ where: { organizationId: orgId } })),
    withTenant(orgId, (tx) => tx.clientLead.count({ where: { organizationId: orgId, firstContactAt: { not: null } } })),
    withPlatform((tx) => tx.savedSearch.count({ where: { organizationId: orgId } })),
    withPlatform((tx) => tx.creditWallet.findUnique({ where: { organizationId: orgId }, select: { lifetimeIn: true } })),
    withPlatform((tx) => tx.creditRequest.count({ where: { organizationId: orgId } })),
    withPlatform((tx) => tx.organization.findUniqueOrThrow({ where: { id: orgId }, select: { settings: true } })),
  ]);
  const auto = ((org.settings as { automation?: { autoAssign?: { mode?: string } } }).automation?.autoAssign?.mode ?? 'off') !== 'off';
  const steps = [
    { key: 'claim', title: 'Claim your free leads', hint: 'Pick leads in the marketplace — your first ones are free.', done: requests > 0, href: '/app/marketplace' },
    { key: 'contact', title: 'Contact your first lead', hint: 'Call or message a lead and log the outcome.', done: contacted > 0, href: '/app/today' },
    { key: 'team', title: 'Invite your team', hint: 'Add the people who will work your leads.', done: members > 1, href: '/app/team' },
    { key: 'search', title: 'Save a search', hint: 'Get alerted when new matching leads arrive.', done: searches > 0, href: '/app/marketplace?tab=saved' },
    { key: 'credits', title: 'Top up credits', hint: 'Buy leads instantly with prepaid credits.', done: (wallet?.lifetimeIn ?? 0) > 0 || creditReqs > 0, href: '/app/billing?tab=credits' },
    { key: 'assign', title: 'Turn on auto-assignment', hint: 'New leads go straight to the right rep.', done: auto, href: '/app/settings?tab=automation' },
  ];
  return { steps, done: steps.filter((s) => s.done).length, total: steps.length };
}

// ── Referrals ──────────────────────────────────────────────────────

export async function myReferral(ctx: AuthContext) {
  const g = await getGrowth();
  const orgId = ctx.orgId!;
  return withPlatform(async (tx) => {
    let rc = await tx.referralCode.findUnique({ where: { organizationId: orgId } });
    if (!rc) {
      let code = randomBytes(4).toString('hex').toUpperCase();
      while (await tx.referralCode.findUnique({ where: { code } })) code = randomBytes(4).toString('hex').toUpperCase();
      rc = await tx.referralCode.create({ data: { organizationId: orgId, code } });
    }
    const refs = await tx.referral.findMany({ where: { referrerOrgId: orgId }, orderBy: { createdAt: 'desc' }, take: 50 });
    const orgs = await tx.organization.findMany({ where: { id: { in: refs.map((r) => r.refereeOrgId) } }, select: { id: true, name: true } });
    return {
      enabled: g.referrals.enabled, code: rc.code, link: `${process.env.APP_URL ?? ''}/join?ref=${rc.code}`,
      rewards: { you: g.referrals.referrerCredits, friend: g.referrals.refereeCredits },
      referrals: refs.map((r) => ({ id: r.id, name: orgs.find((o) => o.id === r.refereeOrgId)?.name ?? 'A business', status: r.status, createdAt: r.createdAt, rewardedAt: r.rewardedAt })),
      earned: refs.filter((r) => r.status === 'REWARDED').length * g.referrals.referrerCredits,
    };
  });
}

/** Links a newly created workspace to the workspace whose code it signed up with. */
export async function recordReferral(refereeOrgId: string, code: string | null | undefined) {
  if (!code) return null;
  const g = await getGrowth();
  if (!g.referrals.enabled) return null;
  return withPlatform(async (tx) => {
    const rc = await tx.referralCode.findUnique({ where: { code: code.trim().toUpperCase() } });
    if (!rc || rc.organizationId === refereeOrgId) return null;
    return tx.referral.upsert({ where: { refereeOrgId }, create: { referrerOrgId: rc.organizationId, refereeOrgId, code: rc.code }, update: {} });
  });
}

/** Rewards both sides once the referred workspace makes its first paid purchase. Idempotent. */
export async function rewardReferral(refereeOrgId: string) {
  const g = await getGrowth();
  if (!g.referrals.enabled) return null;
  return withPlatform(async (tx) => {
    await tx.$queryRaw`SELECT id FROM referrals WHERE "refereeOrgId" = ${refereeOrgId} FOR UPDATE`;
    const r = await tx.referral.findUnique({ where: { refereeOrgId } });
    if (!r || r.status !== 'PENDING') return null;
    await grantCredits(tx, r.referrerOrgId, { type: 'GRANT', credits: g.referrals.referrerCredits, note: 'Referral reward — a business you referred made its first purchase' });
    await grantCredits(tx, r.refereeOrgId, { type: 'GRANT', credits: g.referrals.refereeCredits, note: 'Welcome bonus for joining through a referral' });
    const u = await tx.referral.update({ where: { id: r.id }, data: { status: 'REWARDED', rewardedAt: new Date() } });
    await notifyPermission('crm.billing.view', r.referrerOrgId, { type: 'CREDITS_UPDATED', title: `You earned ${g.referrals.referrerCredits.toLocaleString()} referral credits`, body: 'A business you referred made its first purchase.', link: '/app/billing?tab=credits' }, tx);
    return u;
  });
}

export async function referralOverview(ctx: AuthContext) {
  void ctx;
  return withPlatform(async (tx) => {
    const refs = await tx.referral.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
    const orgs = await tx.organization.findMany({ where: { id: { in: [...new Set(refs.flatMap((r) => [r.referrerOrgId, r.refereeOrgId]))] } }, select: { id: true, name: true } });
    const name = (id: string) => orgs.find((o) => o.id === id)?.name ?? '—';
    return { rows: refs.map((r) => ({ ...r, referrer: name(r.referrerOrgId), referee: name(r.refereeOrgId) })), rewarded: refs.filter((r) => r.status === 'REWARDED').length, pending: refs.filter((r) => r.status === 'PENDING').length };
  });
}
