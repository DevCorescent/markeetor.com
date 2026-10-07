import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, withPlatform, withTenant } from '@/server/db';
import { extractPage } from '@/server/enrichment/extract';
import { invalidateSetting } from '@/server/settings';
import { researchClientLead, researchMarketplaceLead } from '@/server/services/client-research';
import { listClientLeads } from '@/server/services/crm';
import { createDistribution, executeBatch } from '@/server/services/distribution';
import { enrichLead, siteMatchesName } from '@/server/services/enrichment';
import { ctxFor, ensureRoles, makeOrg, makeUser } from '../helpers';

let admin: { id: string };
beforeAll(async () => {
  await ensureRoles();
  admin = await makeUser('platform_owner', null);
});

async function cacheSite(domain: string, name: string, about: string) {
  const html = `<title>${name} | Home</title><meta name="description" content="${about}"><body><p>${about}</p></body>`;
  const f = extractPage(html, `https://${domain}/`, domain);
  await prisma.domainSnapshot.upsert({ where: { domain }, create: { domain, status: 'ok', data: { facts: [{ ...f, links: [], text: '' }] }, text: f.text, pages: [{ url: `https://${domain}/`, status: 200, title: f.title }] }, update: { status: 'ok', fetchedAt: new Date() } });
}
async function lead(email: string, extra: Record<string, unknown> = {}) {
  const id = randomUUID();
  await withPlatform((tx) => tx.lead.create({ data: { id, fullName: 'Sam Ray', email, emailNormalized: email, ...extra } }));
  return id;
}
async function setPolicy(p: Record<string, boolean | number>) {
  const cur = (await prisma.platformSetting.findUnique({ where: { key: 'enrichment.policy' } }))?.value ?? {};
  await prisma.platformSetting.upsert({ where: { key: 'enrichment.policy' }, create: { key: 'enrichment.policy', value: { ...(cur as object), ...p } as never }, update: { value: { ...(cur as object), ...p } as never } });
  invalidateSetting('enrichment.policy');
}

describe('client company research', () => {
  it('researches once, then serves the saved result to everyone without using credits', async () => {
    const tag = Date.now().toString(36);
    const domain = `harbor${tag}dental.test`;
    await cacheSite(domain, 'Harbor Dental', 'Harbor Dental is a family dental clinic offering implants and orthodontics for patients.');
    const a = await lead(`sam@${domain}`, { customFields: { website: `https://${domain}` } });
    const org = await makeOrg();
    const ctx = await ctxFor((await makeUser('client_owner', org.id)).id);
    const first = await researchMarketplaceLead(ctx, a);
    expect(first.status).toBe('DONE');
    expect(first.reused).toBe(false);
    expect(first.company?.name).toBe('Harbor Dental');
    expect(first.quota.used).toBe(1);
    // Another workspace looking at the same lead: instant, free.
    const ctx2 = await ctxFor((await makeUser('client_owner', (await makeOrg()).id)).id);
    const again = await researchMarketplaceLead(ctx2, a);
    expect(again.reused).toBe(true);
    expect(again.quota.used).toBe(0);
    // A second lead from the same company reuses the stored company profile.
    const b = await lead(`ops@${domain}`, { customFields: { website: `https://${domain}` } });
    const e = await enrichLead(b);
    expect(e.engine).toMatch(/^shared:/);
    expect((e.data as { companyName: { value: string } }).companyName.value).toBe('Harbor Dental');
  });

  it('enforces the daily allowance and can be switched off', async () => {
    const org = await makeOrg();
    const ctx = await ctxFor((await makeUser('client_owner', org.id)).id);
    await setPolicy({ clientDailyLimit: 1 });
    try {
      await researchMarketplaceLead(ctx, await lead(`a${Date.now()}@gmail.com`));
      await expect(researchMarketplaceLead(ctx, await lead(`b${Date.now()}@gmail.com`))).rejects.toThrow(/research credits/);
      await setPolicy({ clientResearch: false });
      await expect(researchMarketplaceLead(ctx, await lead(`c${Date.now()}@gmail.com`))).rejects.toThrow(/not available/);
    } finally {
      await setPolicy({ clientDailyLimit: 30, clientResearch: true });
    }
  });

  it('researches a delivered lead and fills the workspace copy where empty', async () => {
    const tag = Date.now().toString(36);
    const domain = `granite${tag}build.test`;
    await cacheSite(domain, 'Granite Builders', 'Granite Builders is a commercial construction contractor building offices and warehouses.');
    const id = await lead(`kim@${domain}`, { customFields: { website: `https://${domain}` } });
    const org = await makeOrg();
    const owner = await makeUser('client_owner', org.id);
    const { batch } = await createDistribution(await ctxFor(admin.id), { selection: { mode: 'ids', ids: [id] }, strategy: 'EQUAL', targets: [{ organizationId: org.id }], respectQuotas: false, includeInvalid: true, idempotencyKey: `cr-${tag}`, confirmLarge: true });
    await executeBatch(batch.id);
    const cl = await withTenant(org.id, (tx) => tx.clientLead.findFirstOrThrow({ where: { organizationId: org.id, leadId: id } }));
    const r = await researchClientLead(await ctxFor(owner.id), cl.id);
    expect(r.profile).toMatchObject({ name: 'Granite Builders', industry: 'Construction', website: `https://${domain}` });
    const after = await withTenant(org.id, (tx) => tx.clientLead.findUniqueOrThrow({ where: { id: cl.id } }));
    expect(after.company).toBe('Granite Builders');
    expect(after.industry).toBe('Construction');
    // My leads shows each lead's research score.
    const { rows } = await listClientLeads(await ctxFor(owner.id), { filter: { conditions: [] }, view: 'active', page: 1, pageSize: 50 });
    expect(rows.find((x) => x.id === cl.id)?.research).toMatchObject({ score: expect.any(Number), status: 'DONE' });
    expect(rows.find((x) => x.id === cl.id)!.research!.score).toBeGreaterThan(0);
  });

  it('only accepts a guessed website when the site carries the company name', () => {
    expect(siteMatchesName('Akshar Eye Clinic', { title: 'Akshar Eye Clinic | Lasik in Mumbai', siteName: null, org: null }, 'akshareyeclinic.com')).toBe(true);
    expect(siteMatchesName('Marsil Exports Pvt Ltd', { title: 'Home', siteName: null, org: null }, 'marsilexports.in')).toBe(true);
    expect(siteMatchesName('Akshar Eye Clinic', { title: 'Domain for sale', siteName: null, org: null }, 'akshar.com')).toBe(false);
    expect(siteMatchesName('Blue Ocean Traders', { title: 'Blue Sky Holidays', siteName: null, org: null }, 'blueoceantraders.com')).toBe(true);
    expect(siteMatchesName('Blue Ocean Traders', { title: 'Blue Sky Holidays', siteName: null, org: null }, 'blue.com')).toBe(false);
  });

  it('reads the CIN on a company site into an official registration block with directory links', async () => {
    const tag = Date.now().toString(36);
    const domain = `lotus${tag}textiles.test`;
    await cacheSite(domain, 'Lotus Textiles', 'Lotus Textiles Private Limited manufactures cotton fabrics and garments. CIN: U17110MH2008PTC181234');
    const id = await lead(`raj@${domain}`, { customFields: { website: `https://${domain}` } });
    const ctx = await ctxFor((await makeUser('client_owner', (await makeOrg()).id)).id);
    const r = await researchMarketplaceLead(ctx, id);
    expect(r.company?.registration).toMatchObject({ source: 'website-cin', regId: 'U17110MH2008PTC181234', yearIncorporated: 2008, type: 'Private limited company', listed: false, registeredIn: 'Maharashtra' });
    expect(r.company?.founded).toBe(2008);
    expect(r.company?.links?.map((l) => l.key)).toEqual(expect.arrayContaining(['zaubacorp', 'tracxn', 'mca']));
    const { askAboutCompany } = await import('@/server/services/company-ask');
    expect((await askAboutCompany(ctx, id, { question: 'When was it incorporated?', history: [] })).answer).toMatch(/2008/);
  });

  it('lets the platform team attach a CIN/LLPIN, unlocking direct directory pages for everyone', async () => {
    const { setCompanyCin } = await import('@/server/services/enrichment');
    const id = await lead(`z${Date.now()}@gmail.com`, { company: 'Orbit Textiles Private Limited' });
    const e = await setCompanyCin(await ctxFor(admin.id), id, 'u17110mh2008ptc181234');
    expect((e?.data as { registry: { value: { regId: string; source: string; yearIncorporated: number } } }).registry.value).toMatchObject({ regId: 'U17110MH2008PTC181234', source: 'manual', yearIncorporated: 2008 });
    const ctx = await ctxFor((await makeUser('client_owner', (await makeOrg()).id)).id);
    const r = await researchMarketplaceLead(ctx, id);
    expect(r.reused).toBe(true);
    expect(r.company?.links?.find((l) => l.key === 'tofler')?.url).toBe('https://www.tofler.in/orbit-textiles-private-limited/company/U17110MH2008PTC181234');
    await expect(setCompanyCin(await ctxFor(admin.id), id, 'NOT-A-CIN')).rejects.toThrow(/valid CIN/);
  });
});
