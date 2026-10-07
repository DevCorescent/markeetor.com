import { afterEach, describe, expect, it, vi } from 'vitest';
import { companyLinks, decodeCin, findCins } from '@/lib/company-registry';

describe('CIN decoding', () => {
  it('reads listing, state, year and company type from a CIN', () => {
    expect(decodeCin('U93000MH2015PTC267169')).toMatchObject({ listed: false, state: 'Maharashtra', yearIncorporated: 2015, type: 'Private limited company', industryCode: '93000' });
    expect(decodeCin('L17110MH1973PLC019786')).toMatchObject({ listed: true, state: 'Maharashtra', yearIncorporated: 1973, type: 'Public limited company' });
    expect(decodeCin('U12345XX3000PTC000001')).toBeNull(); // year in the future
    expect(findCins('© 2024 Acme Pvt Ltd. CIN: U72200KA2015PTC082947 | GSTIN 29ABCDE1234F1Z5')).toEqual(['U72200KA2015PTC082947']);
  });
  it('builds directory links, direct where the identifier makes it certain', () => {
    const l = companyLinks('Marsil Exports Pvt Ltd', { cin: 'U74900MH2010PTC123456' });
    expect(l.map((x) => x.key)).toEqual(expect.arrayContaining(['zaubacorp', 'tracxn', 'falconebiz', 'tofler', 'thecompanycheck', 'mca', 'opencorporates', 'linkedin', 'google']));
    const url = (k: string, ls = l) => ls.find((x) => x.key === k)?.url;
    // Patterns verified on the live sites: each resolves the company page from the CIN.
    expect(url('zaubacorp')).toBe('https://www.zaubacorp.com/companysearchresults/U74900MH2010PTC123456');
    expect(url('falconebiz')).toBe('https://www.falconebiz.com/company/MARSIL-EXPORTS-PVT-LTD-U74900MH2010PTC123456');
    expect(url('tofler')).toBe('https://www.tofler.in/marsil-exports-pvt-ltd/company/U74900MH2010PTC123456');
    expect(url('thecompanycheck')).toBe('https://www.thecompanycheck.com/company/marsil-exports-pvt-ltd/U74900MH2010PTC123456');
    expect(url('opencorporates')).toBe('https://opencorporates.com/companies/in/U74900MH2010PTC123456');
    // LLPs: everything except Falcon eBiz resolves the LLPIN.
    const llp = companyLinks('Marsil Exports LLP', { cin: 'AAA-4095' });
    expect(url('zaubacorp', llp)).toBe('https://www.zaubacorp.com/companysearchresults/AAA-4095');
    expect(url('falconebiz', llp)).toBeUndefined();
    expect(url('tofler', llp)).toBe('https://www.tofler.in/marsil-exports-llp/company/AAA-4095');
    // No identifier: only sites with a working name search.
    const byName = companyLinks('Info Edge (India) Ltd.', { india: true });
    expect(url('zaubacorp', byName)).toBe('https://www.zaubacorp.com/companysearchresults/INFO-EDGE-INDIA');
    expect(byName.map((x) => x.key)).not.toEqual(expect.arrayContaining(['falconebiz']));
    expect(byName.some((x) => x.direct)).toBe(false);
    expect(companyLinks('Acme Inc', { india: false }).map((x) => x.key)).not.toContain('zaubacorp');
  });
});

describe('registry providers', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  it('Falcon eBiz: picks the matching company and never keeps directors or contacts', async () => {
    vi.stubEnv('FALCONEBIZ_API_KEY', 'test-key');
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      calls.push(`${url}|${init.headers.Company}|${init.headers.Authorization}`);
      if (url.endsWith('search_company')) return new Response(JSON.stringify([{ value: 'U74900DL2001PTC000111', label: 'MARSIL TRADERS PRIVATE LIMITED' }, { value: 'U74900MH2010PTC123456', label: 'MARSIL EXPORTS PRIVATE LIMITED' }]));
      return new Response(JSON.stringify({ company_details: { cin: 'U74900MH2010PTC123456', company_name: 'MARSIL EXPORTS PRIVATE LIMITED', incorporation_date: '2010-04-01', auth_capital: '1000000', paid_capital: '500000', category: 'Company limited by Shares', class: 'Private', roc: 'RoC-Mumbai', statusname: 'Active', subcategory: 'Non-govt company', state: 'Maharashtra', district: 'Mumbai', activity: '(Wholesale) Wholesale of textiles', list_status: 'Unlisted' }, contact_details: { address: '12 Some Street', email: 'ceo@marsil.test' }, directors: [{ din: '1', director_name: 'SECRET PERSON', designation: 'Director' }] }));
    }));
    const { falconLookup } = await import('@/server/enrichment/registry');
    const r = await falconLookup('Marsil Exports Pvt Ltd', { state: 'Maharashtra' });
    expect(r).toMatchObject({ source: 'falconebiz', regId: 'U74900MH2010PTC123456', status: 'Active', yearIncorporated: 2010, listed: false, roc: 'RoC-Mumbai', district: 'Mumbai', activity: 'Wholesale of textiles', paidUpCapital: 500000 });
    expect(JSON.stringify(r)).not.toMatch(/SECRET PERSON|ceo@|Some Street/);
    expect(calls[0]).toContain('search_company|Marsil Exports Pvt Ltd|test-key');
    expect(calls[1]).toContain('company_details|U74900MH2010PTC123456');
  });
  it('Falcon eBiz: no confident name match → no record', async () => {
    vi.stubEnv('FALCONEBIZ_API_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([{ value: 'U74900DL2001PTC000111', label: 'TOTALLY DIFFERENT CO PRIVATE LIMITED' }]))));
    const { falconLookup } = await import('@/server/enrichment/registry');
    expect(await falconLookup('Marsil Exports', {})).toBeNull();
  });
});

describe('deep web research', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); vi.doUnmock('@anthropic-ai/sdk'); });
  async function withResponse(input: Record<string, unknown>) {
    vi.stubEnv('AI_PROVIDER_API_KEY', 'test');
    const create = vi.fn(async () => ({ stop_reason: 'tool_use', content: [{ type: 'server_tool_use', name: 'web_search' }, { type: 'tool_use', name: 'record_findings', input }] }));
    vi.doMock('@anthropic-ai/sdk', () => ({ default: class { beta = { messages: { create } }; static APIError = class extends Error { status = 0; }; } }));
    const { webResearch } = await import('@/server/enrichment/web-research');
    return { r: await webResearch({ name: 'Marsil Exports', location: 'Mumbai' }), create };
  }
  const base = { matched: true, legalName: 'MARSIL EXPORTS LLP', website: 'https://marsilexports.com', cin: 'aaa-4095', industry: 'Textiles', specialty: 'Hand embroidery', description: 'Exports hand-embroidered textiles.', products: ['Embroidery', 'Couture'], companySize: '11-50', foundedYear: 2009, hqCity: 'Mumbai', hqState: 'Maharashtra', hqCountry: 'India', status: 'Struck Off', sellsTo: 'businesses', linkedinUrl: 'https://www.linkedin.com/in/someone', confidence: 82, sources: [{ url: 'https://www.zaubacorp.com/MARSIL-EXPORTS-LLP-AAA-4095', title: 'ZaubaCorp' }, { url: 'javascript:alert(1)', title: 'x' }], notes: null };
  it('uses the web search tool and normalises sourced, company-level findings', async () => {
    const { r, create } = await withResponse(base);
    const req = (create.mock.calls[0] as unknown as [Record<string, unknown>])[0] as { tools: { type?: string; name: string }[]; fallbacks: string; model: string };
    expect(req.tools.map((t) => t.type ?? t.name)).toEqual(['web_search_20260209', 'record_findings']);
    expect(req.fallbacks).toBe('default');
    expect(r).toMatchObject({ cin: 'AAA-4095', website: 'https://marsilexports.com', foundedYear: 2009, headquarters: { city: 'Mumbai' }, sellsTo: 'businesses' });
    expect(r?.linkedinUrl).toBeNull(); // personal profiles are never kept
    expect(r?.sources).toEqual([{ url: 'https://www.zaubacorp.com/MARSIL-EXPORTS-LLP-AAA-4095', title: 'ZaubaCorp' }]);
  });
  it('discards results for a different company', async () => {
    const { r } = await withResponse({ ...base, matched: false });
    expect(r).toBeNull();
  });
});
