import { beforeAll, describe, expect, it } from 'vitest';
import { defaultFormConfig, fid, type FormConfig } from '@/lib/onboarding';
import { withPlatform, withTenant } from '@/server/db';
import { createDistribution, executeBatch } from '@/server/services/distribution';
import { funnelTemplates, getFunnel, launchFunnelCampaign, previewFunnel, runFunnelAutomations, saveFunnel, stageLeads } from '@/server/services/funnels';
import { approveApplication, createForm, deleteForm, deliverWelcomeLeads, publicForm, rejectApplication, saveForm, setHomepage, siteHomepage, submitApplication, validateAnswers } from '@/server/services/onboarding';
import { defaultFinderPage, newSection } from '@/lib/homepage';
import { emptyCriteria, homeFinderTurn } from '@/server/services/lead-finder';
import { ctxFor, ensureRoles, makeLeads, makeOrg, makeUser } from '../helpers';

let admin: { id: string };
beforeAll(async () => {
  await ensureRoles();
  admin = await makeUser('platform_owner', null);
});

async function workspace(statuses: string[]) {
  const org = await makeOrg();
  const owner = await makeUser('client_owner', org.id);
  const ids = await makeLeads(statuses.length);
  const { batch } = await createDistribution(await ctxFor(admin.id), { selection: { mode: 'ids', ids }, strategy: 'EQUAL', targets: [{ organizationId: org.id }], respectQuotas: true, includeInvalid: false, idempotencyKey: `f-${org.id}`, confirmLarge: true });
  await executeBatch(batch.id);
  const leads = await withTenant(org.id, (tx) => tx.clientLead.findMany({ where: { organizationId: org.id }, orderBy: { createdAt: 'asc' } }));
  for (let i = 0; i < leads.length; i++) await withTenant(org.id, (tx) => tx.clientLead.update({ where: { id: leads[i].id }, data: { status: statuses[i] as 'NEW' } }));
  return { org, ctx: await ctxFor(owner.id), leads };
}

describe('funnels', () => {
  it('computes reached / current counts, conversions and the bottleneck', async () => {
    const { ctx } = await workspace(['NEW', 'NEW', 'NEW', 'CONTACTED', 'CONTACTED', 'QUALIFIED', 'CONVERTED', 'LOST']);
    const sales = (await funnelTemplates(ctx)).find((t) => t.key === 'sales')!;
    const f = await saveFunnel(ctx, null, { name: 'Sales', status: 'ACTIVE', baseFilter: { conditions: [] }, stages: sales.stages });
    const { analysis } = await getFunnel(ctx, f.id);
    expect(analysis.total).toBe(8);
    expect(analysis.stages.map((s) => s.reached)).toEqual([8, 4, 2, 1, 1]);
    expect(analysis.stages.map((s) => s.current)).toEqual([4, 2, 1, 0, 1]);
    expect(analysis.stages[1].conversion).toBe(0.5);
    expect(analysis.bottleneck).toMatchObject({ id: sales.stages[0].id, rate: 0.5 }); // ties go to the earliest stage
    const preview = await previewFunnel(ctx, { baseFilter: { conditions: [] }, stages: sales.stages.slice(0, 2) });
    expect(preview.stages.map((s) => s.reached)).toEqual([8, 4]);
    const contacted = await stageLeads(ctx, f.id, sales.stages[1].id, 'CURRENT', 1, 50);
    expect(contacted.total).toBe(2);
  });

  it('launches task campaigns at a stage and runs stage automations once per lead', async () => {
    const { org, ctx, leads } = await workspace(['NEW', 'NEW', 'CONTACTED']);
    const f = await saveFunnel(ctx, null, {
      name: 'Nurture', status: 'ACTIVE', baseFilter: { conditions: [] },
      stages: [
        { id: 'arrived', name: 'Arrived', conditions: [], automation: { enabled: true, action: 'TASK', taskTitle: 'Welcome call', dueInHours: 2, onlyNew: true } },
        { id: 'contacted', name: 'Contacted', conditions: [{ field: 'status', op: 'in', value: ['CONTACTED'] }] },
      ],
    });
    // Existing leads were baselined: the automation does nothing for them.
    expect((await runFunnelAutomations()).acted).toBe(0);
    // A lead that leaves "Contacted" back to New counts as a new arrival in "Arrived".
    await withTenant(org.id, (tx) => tx.clientLead.update({ where: { id: leads[2].id }, data: { status: 'NEW' } }));
    await runFunnelAutomations();
    expect(await withTenant(org.id, (tx) => tx.task.count({ where: { organizationId: org.id, title: 'Welcome call' } }))).toBe(1);
    await runFunnelAutomations();
    expect(await withTenant(org.id, (tx) => tx.task.count({ where: { organizationId: org.id, title: 'Welcome call' } }))).toBe(1);

    const c = await launchFunnelCampaign(ctx, f.id, { stageId: 'arrived', scope: 'CURRENT', channel: 'TASK', name: 'Call blitz', task: { title: 'Blitz call', dueInHours: 24 } });
    expect(c.recipients).toBe(3);
    expect(await withTenant(org.id, (tx) => tx.task.count({ where: { organizationId: org.id, title: 'Blitz call' } }))).toBe(3);
    const other = await workspace(['NEW']);
    await expect(getFunnel(other.ctx, f.id)).rejects.toThrow(/not found/i);
  });
});

describe('onboarding', () => {
  async function publishedForm(mut: (c: FormConfig) => void = () => {}) {
    const actx = await ctxFor(admin.id);
    const f = await createForm(actx, { name: `Partners ${Math.random().toString(36).slice(2, 7)}` });
    const config = defaultFormConfig();
    mut(config);
    await saveForm(actx, f.id, { name: f.name, slug: f.slug, status: 'PUBLISHED', config });
    return f;
  }
  const valid = (email: string) => ({ businessName: 'Acme Realty', contactName: 'Jane Doe', email, website: 'https://acme-realty.test', industry: 'Real Estate', consent: true });

  it('validates answers, honours conditional fields and keeps internal settings private', async () => {
    const config = defaultFormConfig();
    config.fields.push({ id: fid(), key: 'otherIndustry', type: 'text', label: 'Which?', required: true, width: 'full', step: 1, showIf: { key: 'industry', op: 'equals', value: 'Other' } });
    expect(validateAnswers(config, valid('a@b.test')).errors).toEqual({});
    expect(validateAnswers(config, { ...valid('a@b.test'), industry: 'Other' }).errors).toHaveProperty('otherIndustry');
    expect(validateAnswers(config, { ...valid('not-an-email'), consent: false }).errors).toMatchObject({ email: expect.any(String), consent: expect.any(String) });
    const f = await publishedForm();
    const pub = await publicForm(f.slug);
    expect(JSON.stringify(pub)).not.toMatch(/activation|autoApprove|maxActiveLeads/);
    await expect(saveForm(await ctxFor(admin.id), f.id, { name: f.name, slug: f.slug, status: 'PUBLISHED', config: { ...config, fields: config.fields.filter((x) => x.key !== 'email') } })).rejects.toThrow(/email/);
  });

  it('flags, scores and blocks per settings; catches bots silently', async () => {
    const f = await publishedForm((c) => { c.settings.requireBusinessEmail = true; });
    await expect(submitApplication(f.slug, { answers: valid('jane@gmail.com') }, { ip: '1.1.1.1', userAgent: 'x' })).rejects.toThrow(/highlighted/);
    const ok = await submitApplication(f.slug, { answers: valid(`jane${Date.now()}@acme-realty.test`), startedAt: Date.now() - 60_000 }, { ip: '1.1.1.1', userAgent: 'x' });
    const app = await withPlatform((tx) => tx.onboardingApplication.findUniqueOrThrow({ where: { id: ok.id } }));
    expect(app.status).toBe('PENDING');
    expect(app.flags).not.toContain('website_mismatch');
    expect(app.quality).toBeGreaterThanOrEqual(50); // business email + website, several optional fields blank
    const bot = await submitApplication(f.slug, { answers: valid('bot@acme-realty.test'), hp: 'http://spam' }, { ip: '2.2.2.2', userAgent: 'bot' });
    expect((await withPlatform((tx) => tx.onboardingApplication.findUniqueOrThrow({ where: { id: bot.id } }))).status).toBe('SPAM');
  });

  it('activates a workspace and invites the owner on approval; rejection is recorded', async () => {
    const f = await publishedForm();
    const email = `owner${Date.now()}@newbiz.test`;
    const sub = await submitApplication(f.slug, { answers: { ...valid(email), website: 'https://newbiz.test' }, leadInterests: { criteria: { industries: ['Real Estate'] } as never, matches: 12 } }, { ip: null, userAgent: null });
    const res = await approveApplication(await ctxFor(admin.id), sub.id, { maxActiveLeads: 250 });
    expect(res.inviteSentTo).toBe(email);
    const org = await withPlatform((tx) => tx.organization.findUniqueOrThrow({ where: { id: res.organization.id }, include: { quota: true } }));
    expect(org.name).toBe('Acme Realty');
    expect(org.quota?.maxActiveLeads).toBe(250);
    expect((org.settings as { onboarding?: { leadInterests?: unknown } }).onboarding?.leadInterests).toBeTruthy();
    expect(await withPlatform((tx) => tx.invitation.count({ where: { email, organizationId: org.id } }))).toBe(1);
    await expect(approveApplication(await ctxFor(admin.id), sub.id, {})).rejects.toThrow(/already/);

    const sub2 = await submitApplication(f.slug, { answers: valid(`x${Date.now()}@other.test`) }, { ip: null, userAgent: null });
    const r = await rejectApplication(await ctxFor(admin.id), sub2.id, { reason: 'Outside our service area', notify: false });
    expect(r.status).toBe('REJECTED');
  });

  it('auto-approves when the form says so', async () => {
    const f = await publishedForm((c) => { c.settings.autoApprove = true; });
    const r = await submitApplication(f.slug, { answers: valid(`auto${Date.now()}@instant.test`) }, { ip: null, userAgent: null });
    expect(r.activated).toBe(true);
  });

  it('serves a published form as the site homepage with a generated or custom landing page', async () => {
    const actx = await ctxFor(admin.id);
    const draft = await createForm(actx, { name: `Home ${Date.now()}` });
    await expect(setHomepage(actx, draft.id)).rejects.toThrow(/Publish/);
    const f = await publishedForm();
    await setHomepage(actx, f.id);
    const home = await siteHomepage();
    expect(home?.form.slug).toBe(f.slug);
    expect(home?.homepage.sections.some((x) => x.type === 'hero' && x.layout === 'form-right')).toBe(true);
    expect(JSON.stringify(home)).not.toMatch(/maxActiveLeads|autoApprove/);

    const config = defaultFormConfig();
    const cta = newSection('cta');
    config.homepage = { mode: 'page', finder: defaultFinderPage(), nav: { show: true, sticky: true, links: [], showSignIn: false, signInLabel: 'Sign in', cta: null }, sections: [cta], footer: { text: '', links: [], showPoweredBy: false }, seo: { title: 'Welcome', description: '' } };
    await saveForm(actx, f.id, { name: f.name, slug: f.slug, status: 'PUBLISHED', config });
    expect((await siteHomepage())?.homepage.seo.title).toBe('Welcome');
    // Links are restricted to safe schemes.
    const bad = structuredClone(config);
    bad.homepage!.nav.links = [{ label: 'x', href: 'javascript:alert(1)' }];
    await expect(saveForm(actx, f.id, { name: f.name, slug: f.slug, status: 'PUBLISHED', config: bad })).rejects.toThrow();

    // A form that is no longer published stops serving the homepage; deleting it clears the setting.
    await saveForm(actx, f.id, { name: f.name, slug: f.slug, status: 'DRAFT', config });
    expect(await siteHomepage()).toBeNull();
    await deleteForm(actx, f.id);
    expect(await siteHomepage()).toBeNull();
    await setHomepage(actx, null);
  });

  it('homepage Lead Finder shows masked matches, and free leads are delivered once the new owner joins', async () => {
    const industry = `Finder-${Date.now()}`;
    await makeLeads(14, { industry, score: 77, country: 'US' });
    const t = await homeFinderTurn({ message: null, action: { type: 'relax', criteria: { ...emptyCriteria(), industries: [industry] } }, criteria: emptyCriteria(), history: [] }, { autoApprove: false });
    expect(t.results?.total).toBe(14);
    expect(t.results?.claimable).toBe(10);
    // Previews never carry identities, contact details, ids or prices.
    expect(Object.keys(t.results!.sample[0]).sort()).toEqual(['addedDays', 'country', 'fresh', 'hasEmail', 'hasPhone', 'industry', 'ref', 'score', 'seniority', 'state']);
    const faq = await homeFinderTurn({ message: 'are the leads really free?', action: null, criteria: emptyCriteria(), history: [] }, { autoApprove: false });
    expect(faq.reply).toMatch(/10 leads are free/);

    const f = await publishedForm();
    const email = `finder${Date.now()}@leadsco.test`;
    const sub = await submitApplication(f.slug, { answers: { ...valid(email), website: 'https://leadsco.test' }, leadInterests: { criteria: { ...emptyCriteria(), industries: [industry] }, summary: industry, matches: 14 } }, { ip: null, userAgent: null });
    const res = await approveApplication(await ctxFor(admin.id), sub.id, {});
    const owner = await makeUser('client_owner', res.organization.id);
    const r = await deliverWelcomeLeads(owner.id);
    expect(r?.status).toBe('FULFILLED');
    const leads = await withTenant(res.organization.id, (tx) => tx.clientLead.findMany({ where: { organizationId: res.organization.id }, select: { industry: true } }));
    expect(leads).toHaveLength(10);
    expect(leads.every((l) => l.industry === industry)).toBe(true);
    expect(await deliverWelcomeLeads(owner.id)).toBeNull();
    const req = await withPlatform((tx) => tx.leadRequest.findFirstOrThrow({ where: { organizationId: res.organization.id } }));
    expect(Number(req.total)).toBe(0);
  });
});
