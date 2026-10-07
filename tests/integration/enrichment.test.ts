import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PRICING } from '@/lib/pricing';
import { prisma, withPlatform } from '@/server/db';
import { extractPage } from '@/server/enrichment/extract';
import { enrichLead, queueEnrichment } from '@/server/services/enrichment';
import { emptyCriteria, homeFinderTurn } from '@/server/services/lead-finder';
import { companyPreview, listCatalog } from '@/server/services/marketplace';
import { askAboutCompany } from '@/server/services/company-ask';
import { makeOrg } from '../helpers';
import { ctxFor, ensureRoles, makeUser } from '../helpers';

let admin: { id: string };
beforeAll(async () => {
  await ensureRoles();
  admin = await makeUser('platform_owner', null);
});

/** Seeds the per-domain crawl cache so tests never touch the network. */
async function cacheSite(domain: string, html: string) {
  const f = extractPage(html, `https://${domain}/`, domain);
  await prisma.domainSnapshot.upsert({
    where: { domain },
    create: { domain, status: 'ok', data: { facts: [{ ...f, links: [], text: '' }], origin: `https://${domain}` }, text: f.text, pages: [{ url: `https://${domain}/`, status: 200, title: f.title }] },
    update: { status: 'ok', fetchedAt: new Date(), data: { facts: [{ ...f, links: [], text: '' }], origin: `https://${domain}` }, text: f.text },
  });
}

async function lead(data: Partial<{ email: string; company: string; website: string; jobTitle: string; phone: string }>) {
  const id = randomUUID();
  await withPlatform((tx) => tx.lead.create({ data: { id, fullName: 'Pat Lee', email: data.email, emailNormalized: data.email, phone: data.phone, phoneNormalized: data.phone, company: data.company, jobTitle: data.jobTitle, customFields: data.website ? { Website: data.website } : {} } }));
  return id;
}

describe('lead enrichment', () => {
  it('builds a sourced profile from the company site, fills empty fields and powers keyword search', async () => {
    const tag = Date.now().toString(36);
    const domain = `peak${tag}roofing.test`;
    await cacheSite(domain, `<title>Peak Roofing | Commercial roofing contractor</title><meta name="description" content="Commercial roofing contractor serving Denver businesses.">
      <script type="application/ld+json">{"@type":"RoofingContractor","name":"Peak Roofing","foundingDate":"2004","numberOfEmployees":"120","address":{"addressLocality":"Denver","addressRegion":"CO","addressCountry":"US"}}</script>
      <body><p>Commercial roofing, roof repair and roofing inspections. Our roofing contractor crews handle construction projects.</p><a href="mailto:info@${domain}">x</a><a href="https://www.linkedin.com/company/peak-roofing">in</a></body>`);
    const id = await lead({ email: `pat@${domain}`, website: `https://www.${domain}`, jobTitle: 'VP of Operations', phone: '+14155552671' });
    const e = await enrichLead(id, { actorId: admin.id });
    expect(e.status).toBe('DONE');
    expect(e.engine).toBe('heuristic');
    expect(e.domain).toBe(domain);
    const data = e.data as Record<string, { value: unknown; confidence: number }>;
    expect(data.companyName.value).toBe('Peak Roofing');
    expect(data.industry.value).toBe('Construction');
    expect(data.companySize.value).toBe('51-200');
    expect(data.seniority.value).toBe('Director');
    expect((e.checks as { phone: { valid: boolean } }).phone.valid).toBe(true);
    expect(e.searchText).toContain('roofing');
    expect(e.searchText).not.toContain('peak');
    const l = await withPlatform((tx) => tx.lead.findUniqueOrThrow({ where: { id } }));
    expect(l.company).toBe('Peak Roofing');
    expect(l.industry).toBe('Construction');
    expect((l.customFields as { enrichment?: { linkedin?: string } }).enrichment?.linkedin).toContain('linkedin.com/company');
    // Recently researched leads are not redone unless forced.
    expect((await enrichLead(id)).id).toBe(e.id);

    // Lead Finder: a niche term that isn't an industry name now finds this lead.
    const t = await homeFinderTurn({ message: `roofing contractors ${tag}`, action: null, criteria: emptyCriteria(), history: [] }, { autoApprove: false });
    expect((t.criteria as { keywords: string[] }).keywords).toContain('roofing');
    const cat = await listCatalog(await ctxFor(admin.id), { filter: { conditions: [{ field: 'keyword', op: 'in', value: ['roofing'] }] }, page: 1, pageSize: 50 });
    expect(cat.total).toBeGreaterThanOrEqual(1);
    // The marketplace shows an anonymised company profile to help clients decide.
    const row = cat.rows.find((x) => x.id === id)!;
    expect(row.company).toMatchObject({ researched: true, size: '51-200', founded: 2004, headquarters: 'CO, US' });
    expect(row.company?.signals).toMatchObject({ website: true, linkedin: true, businessEmail: expect.any(Boolean) });
    expect(row.company?.keywords).toContain('roofing');
    const shown = JSON.stringify(row);
    expect(row.company?.name).toBe('Peak Roofing');

    // Ask AI: company basics only — people and contact details are always declined or scrubbed.
    const org = await makeOrg();
    const cctx = await ctxFor((await makeUser('client_owner', org.id)).id);
    const ask = (question: string) => askAboutCompany(cctx, id, { question, history: [] }).then((r) => r.answer);
    expect(await ask('How big is the company?')).toMatch(/51.200 employees/);
    expect(await ask('When was it founded?')).toMatch(/2004/);
    expect(await ask('What do they do?')).toMatch(/roofing/i);
    for (const q of ['Who is the owner?', 'Give me their phone number', 'What is the CEO name', 'Share the contact email', 'What is their website?']) expect(await ask(q)).toMatch(/kept private/);
    for (const q of ['Tell me about them', 'What do they do?', 'Where are they based?']) expect(await ask(q)).not.toMatch(new RegExp(`${domain}|info@|linkedin\\.com|\\+?1?\\s?303`, 'i'));
    // The company's own website and LinkedIn page are company information (Admin → Company preview); contact details never show.
    expect(row.company).toMatchObject({ website: `https://${domain}`, linkedin: expect.stringMatching(/linkedin\.com\/company\//) });
    expect(shown).not.toMatch(/info@|\+1 ?303/);
    const stored = await withPlatform((tx) => tx.lead.findFirst({ where: { id }, select: { company: true, enrichment: { select: { status: true, confidence: true, data: true, checks: true, domain: true, finishedAt: true } } } }));
    const hidden = companyPreview(stored!, { ...DEFAULT_PRICING.companyPreview, website: false })!;
    expect(hidden).toMatchObject({ website: null, linkedin: null });
        // Company names are stripped from the search index, so keywords can't probe for a business.
    const probe = await listCatalog(await ctxFor(admin.id), { filter: { conditions: [{ field: 'keyword', op: 'in', value: [`peak${tag}`] }] }, page: 1, pageSize: 50 });
    expect(probe.total).toBe(0);
  });

  it('personal emails get verification only; bulk runs skip fresh research and never overwrite by default', async () => {
    const a = await lead({ email: `pat${Date.now()}@gmail.com`, company: 'Existing Co' });
    const r = await enrichLead(a, { actorId: admin.id });
    expect(r.status).toBe('PARTIAL');
    expect((r.checks as { email: { free: boolean } }).email.free).toBe(true);
    expect((await withPlatform((tx) => tx.lead.findUniqueOrThrow({ where: { id: a } }))).company).toBe('Existing Co');
    const b = await lead({ email: `x${Date.now()}@yahoo.com` });
    const q = await queueEnrichment(await ctxFor(admin.id), { selection: { mode: 'ids', ids: [a, b] }, force: false });
    expect(q.queued).toBe(1);
    expect(q.skipped).toBe(1);
    expect((await prisma.leadEnrichment.findUniqueOrThrow({ where: { leadId: b } })).status).toBe('PARTIAL');
  });

  it('company preview respects marketplace settings and redacts identifying text', () => {
    const e = { status: 'DONE' as const, confidence: 80, domain: 'acmeroof.test', finishedAt: new Date(), checks: {}, data: {
      companyName: { value: 'Acme Roofing LLC', confidence: 90 }, description: { value: 'Acme Roofing is a commercial roofer. Visit acmeroof.test or call +1 303 555 0100.', confidence: 80 },
      headquarters: { value: { city: 'Denver', state: 'CO', country: 'US' }, confidence: 80 }, foundedYear: { value: 1990, confidence: 40 },
    } };
    const on = { enabled: true, name: false, description: true, size: true, founded: true, headquarters: 'city' as const, keywords: true, signals: true, website: true };
    const c = companyPreview({ company: null, enrichment: e as never }, on)!;
    expect(c.description).toBe('The company is a commercial roofer.');
    expect(c.headquarters).toBe('Denver, CO, US');
    expect(c.founded).toBeNull(); // low confidence facts are left out
    expect(companyPreview({ company: null, enrichment: e as never }, { ...on, headquarters: 'country' })!.headquarters).toBe('US');
    expect(companyPreview({ company: null, enrichment: e as never }, { ...on, enabled: false })).toBeNull();
    // With names on (default), the name is shown and only contact details are removed from the text.
    const named = companyPreview({ company: null, enrichment: e as never }, { ...on, name: true })!;
    expect(named.name).toBe('Acme Roofing LLC');
    expect(named.description).toBe('Acme Roofing is a commercial roofer.');
    // Unresearched leads still show a known company name — and never a person's name.
    expect(companyPreview({ company: 'Known Co', enrichment: null }, { ...on, name: true })).toMatchObject({ name: 'Known Co', researched: false });
    expect(companyPreview({ company: null, fullName: 'Ravi Kumar', enrichment: null }, { ...on, name: true })).toBeNull();
    expect(companyPreview({ company: null, fullName: 'Sunrise Exports Pvt Ltd', enrichment: null }, { ...on, name: true })?.name).toBe('Sunrise Exports Pvt Ltd');
    const clinic = { ...e, domain: 'akshareyeclinic.com', data: { description: { value: 'Akshar Eye Clinic in Malad offers expert Lasik surgery.', confidence: 85 } } };
    expect(companyPreview({ company: null, enrichment: clinic as never }, on)!.description).toBe('The company in Malad offers expert Lasik surgery.');
  });
});
