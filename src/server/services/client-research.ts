import type { LeadEnrichment } from '@prisma/client';
import { cleanCompanyName } from '@/lib/business';
import { companyLinks } from '@/lib/company-registry';
import type { AuthContext } from '../auth/context';
import { withPlatform, withTenant } from '../db';
import { AppError, notFound } from '../errors';
import { redis } from '../redis';
import { getSetting } from '../settings';
import { visibleLead } from './crm';
import { aiStatus } from '../ai';
import { webResearchAvailable } from '../enrichment/web-research';
import { enrichLead } from './enrichment';
import { companyPreview, getPricing, MARKET_AVAILABLE, registrationOf } from './marketplace';

/**
 * Company research started from a client workspace. Results are stored once on the platform's master lead
 * (and its company's website snapshot), so any later viewer — in any workspace — gets them instantly
 * without researching again. Each workspace has a daily allowance; already-researched companies don't
 * use it.
 */

const fresh = (e: LeadEnrichment | null, days: number) => Boolean(e && (e.status === 'DONE' || e.status === 'PARTIAL') && e.finishedAt && Date.now() - e.finishedAt.getTime() < days * 86_400_000);

async function spendCredit(ctx: AuthContext) {
  const policy = await getSetting('enrichment.policy');
  if (!policy.clientResearch) throw new AppError('FORBIDDEN', 'Company research is not available right now');
  const key = `enrich:client:${ctx.orgId}:${new Date().toISOString().slice(0, 10)}`;
  const used = await redis().incr(key).catch(() => 1);
  if (used === 1) await redis().expire(key, 26 * 3600).catch(() => null);
  if (used > policy.clientDailyLimit) {
    await redis().decr(key).catch(() => null);
    throw new AppError('RATE_LIMITED', `Your workspace has used today’s ${policy.clientDailyLimit} company research credits. Already-researched companies are always free to view.`);
  }
  return { used, limit: policy.clientDailyLimit };
}
async function refundCredit(ctx: AuthContext) {
  await redis().decr(`enrich:client:${ctx.orgId}:${new Date().toISOString().slice(0, 10)}`).catch(() => null);
}

export async function researchQuota(ctx: AuthContext) {
  const policy = await getSetting('enrichment.policy');
  const used = Number(await redis().get(`enrich:client:${ctx.orgId}:${new Date().toISOString().slice(0, 10)}`).catch(() => 0)) || 0;
  return { enabled: policy.clientResearch, used: Math.min(used, policy.clientDailyLimit), limit: policy.clientDailyLimit };
}

async function run(ctx: AuthContext, leadId: string) {
  const policy = await getSetting('enrichment.policy');
  const existing = await withPlatform((tx) => tx.leadEnrichment.findUnique({ where: { leadId } }));
  // A partial result from before deep web research was available is worth deepening once.
  const ai = await aiStatus();
  const deepen = existing?.status === 'PARTIAL' && policy.webResearch && ai.enabled && webResearchAvailable() && !(existing.engine ?? '').includes('web');
  if (fresh(existing, policy.refreshDays) && !deepen) return { enrichment: existing!, reused: true };
  const credit = await spendCredit(ctx);
  const e = await enrichLead(leadId, { actorId: ctx.user.id, force: deepen });
  // Nothing new was learned because the work failed: give the credit back.
  if (e.status === 'FAILED') await refundCredit(ctx);
  return { enrichment: e, reused: false, credit };
}

// ── Marketplace (before purchase) ──────────────────────────────────

export async function researchMarketplaceLead(ctx: AuthContext, leadId: string) {
  const p = await getPricing();
  if (!p.marketplaceEnabled || !p.companyPreview.enabled) throw new AppError('FORBIDDEN', 'Company details are not available');
  const available = await withPlatform((tx) => tx.lead.findFirst({ where: { AND: [MARKET_AVAILABLE, { id: leadId }] }, select: { id: true } }));
  if (!available) throw notFound('Lead');
  const r = await run(ctx, leadId);
  const row = await withPlatform((tx) => tx.lead.findUniqueOrThrow({ where: { id: leadId }, select: { company: true, fullName: true, enrichment: { select: { status: true, confidence: true, data: true, checks: true, domain: true, finishedAt: true } } } }));
  return { status: r.enrichment.status, reused: r.reused, company: companyPreview(row, p.companyPreview), quota: await researchQuota(ctx) };
}

// ── My leads (after delivery) ──────────────────────────────────────

type F = { value: unknown; confidence: number } | undefined;

/** Fuller profile for a lead the workspace owns: includes the company website and LinkedIn page. */
function ownedProfile(e: LeadEnrichment | null, companyFallback: string | null) {
  if (!e || (e.status !== 'DONE' && e.status !== 'PARTIAL')) return null;
  const d = (e.data ?? {}) as Record<string, F>;
  const v = <T,>(k: string, min = 55) => (d[k] && d[k]!.confidence >= min ? (d[k]!.value as T) : null);
  const hq = v<{ city?: string | null; state?: string | null; country?: string | null }>('headquarters');
  const crawl = (e.checks as { crawl?: { status?: string } | null } | null)?.crawl;
  const website = v<string>('website', 80) ?? (e.domain && crawl?.status === 'ok' ? `https://${e.domain}` : null);
  return {
    status: e.status, researchedAt: e.finishedAt, confidence: e.confidence,
    name: cleanCompanyName(v<string>('companyName') ?? companyFallback, e.domain),
    industry: v<string>('industry'), specialty: v<string>('subIndustry'), description: v<string>('description'),
    size: v<string>('companySize'), founded: v<number>('foundedYear'),
    headquarters: hq ? [hq.city, hq.state, hq.country].filter(Boolean).join(', ') || null : null,
    keywords: v<string[]>('keywords') ?? [], sellsTo: v<boolean>('b2b') == null ? null : v<boolean>('b2b') ? 'Businesses' : 'Consumers',
    website, linkedin: v<string>('linkedin', 70),
    registration: registrationOf(v('registry', 80)),
    links: (() => { const n = cleanCompanyName(v<string>('companyName') ?? companyFallback, e.domain); const reg = registrationOf(v('registry', 80)); return n ? companyLinks(n, { cin: reg?.regId ?? null, india: Boolean(reg?.regId) || /\b(pvt|private limited|llp)\b/i.test(n) }) : []; })(),
    sources: ((e.sources ?? []) as { url: string; title: string | null }[]).slice(0, 5),
  };
}

export async function clientLeadResearch(ctx: AuthContext, clientLeadId: string) {
  const cl = await withTenant(ctx.orgId!, (tx) => visibleLead(tx, ctx, clientLeadId));
  const e = await withPlatform((tx) => tx.leadEnrichment.findUnique({ where: { leadId: cl.leadId } }));
  const profile = ownedProfile(e, cl.company);
  const name = cleanCompanyName(cl.company);
  return { profile, links: profile?.links ?? (name ? companyLinks(name, { india: /\b(pvt|private limited|llp)\b/i.test(name) || cl.country === 'India' }) : []), quota: await researchQuota(ctx) };
}

export async function researchClientLead(ctx: AuthContext, clientLeadId: string) {
  const cl = await withTenant(ctx.orgId!, (tx) => visibleLead(tx, ctx, clientLeadId));
  const r = await run(ctx, cl.leadId);
  const profile = ownedProfile(r.enrichment, cl.company);
  // Fill the workspace's own copy where it is still empty — never overwrite what the team entered.
  if (profile && (r.enrichment.status === 'DONE')) {
    const patch: { company?: string; industry?: string } = {};
    if (!cl.company && profile.name) patch.company = profile.name;
    if (!cl.industry && profile.industry) patch.industry = profile.industry;
    if (Object.keys(patch).length) await withTenant(ctx.orgId!, (tx) => tx.clientLead.update({ where: { id: cl.id }, data: patch }));
  }
  return { profile, reused: r.reused, status: r.enrichment.status, quota: await researchQuota(ctx) };
}
