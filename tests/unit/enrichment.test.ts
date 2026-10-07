import { describe, expect, it } from 'vitest';
import { classifyIndustry, companyFromTitle, extractPage, pickPages, sizeBucket } from '@/server/enrichment/extract';
import { FetchError, isBlockedAddress, parseRobots, robotsAllows, safeFetch, validateUrl } from '@/server/enrichment/fetch';

describe('enrichment fetcher safety', () => {
  it('blocks internal, loopback, link-local and metadata addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) expect(isBlockedAddress(ip)).toBe(true);
    for (const ip of ['8.8.8.8', '151.101.1.69', '2606:4700::1111']) expect(isBlockedAddress(ip)).toBe(false);
  });
  it('rejects non-web schemes, credentials, raw IPs and odd ports', async () => {
    for (const u of ['file:///etc/passwd', 'ftp://acme.com', 'http://user:pw@acme.com', 'http://127.0.0.1/', 'http://[::1]/', 'http://acme.com:6379', 'http://localhost/']) expect(() => validateUrl(u)).toThrow(FetchError);
    expect(validateUrl('https://acme.com/about').hostname).toBe('acme.com');
    await expect(safeFetch('http://169.254.169.254/latest/meta-data')).rejects.toThrow(FetchError);
  });
  it('honours robots.txt for our agent, longest rule wins', () => {
    const r = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/about\n\nUser-agent: BadBot\nDisallow: /');
    expect(robotsAllows(r, '/')).toBe(true);
    expect(robotsAllows(r, '/private/x')).toBe(false);
    expect(robotsAllows(r, '/private/about')).toBe(true);
    const all = parseRobots('User-agent: *\nDisallow: /');
    expect(robotsAllows(all, '/about')).toBe(false);
    const ours = parseRobots('User-agent: *\nAllow: /\nUser-agent: LeadsCRM-Enrichment\nDisallow: /contact');
    expect(robotsAllows(ours, '/contact')).toBe(false);
  });
});

describe('page extraction', () => {
  const html = `<html><head><title>Home | Summit Roofing Co.</title><meta name="description" content="Commercial &amp; residential roofing contractor in Denver.">
    <meta property="og:site_name" content="Summit Roofing">
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"RoofingContractor","name":"Summit Roofing Co.","telephone":"+1 303 555 0100","foundingDate":"1998","numberOfEmployees":{"value":"45"},"address":{"addressLocality":"Denver","addressRegion":"CO","addressCountry":"US"},"sameAs":["https://www.linkedin.com/company/summit-roofing"]}</script>
    <script>var x = "ignore me";</script></head><body><nav><a href="/about-us">About</a><a href="/contact">Contact</a><a href="/blog/2020/01/01/post">Post</a>
    <a href="mailto:info@summitroofing.test">Email</a><a href="tel:+13035550100">Call</a><a href="https://www.facebook.com/summitroofing">FB</a></nav>
    <h1>Denver roofing contractor</h1><p>We install commercial roofing and residential roofing, repairs and inspections. Licensed roofing contractor since 1998.</p></body></html>`;
  const f = extractPage(html, 'https://summitroofing.test/', 'summitroofing.test');
  it('reads structured data, contacts, socials and readable text', () => {
    expect(f.org?.name).toBe('Summit Roofing Co.');
    expect(f.org?.address?.city).toBe('Denver');
    expect(f.description).toContain('Commercial & residential');
    expect(f.emails).toEqual(['info@summitroofing.test']);
    expect(f.phones).toEqual(['+13035550100']);
    expect(f.socials.facebook).toContain('facebook.com/summitroofing');
    expect(f.text).not.toContain('ignore me');
    expect(pickPages(f.links, 'https://summitroofing.test')[0]).toBe('https://summitroofing.test/about-us');
  });
  it('classifies industry and normalises size / name', () => {
    expect(classifyIndustry(`${f.title} ${f.description} ${f.text}`, ['Real Estate', 'Construction'])?.industry).toBe('Construction');
    expect(classifyIndustry('Welcome to our website', [])).toBeNull();
    expect(sizeBucket('45')).toBe('11-50');
    expect(companyFromTitle('Home | Summit Roofing Co.', 'summitroofing.test')).toBe('Summit Roofing Co.');
  });
});

describe('contact checks', () => {
  it('spots numbers imported with the wrong country code and suggests the right one', async () => {
    const { runChecks } = await import('@/server/services/enrichment');
    const c = await runChecks({ email: null, emailNormalized: null, phone: '+18862921256', phoneNormalized: '+18862921256', jobTitle: 'Founder & CEO', fullName: 'X', state: 'Jharkhand', country: null });
    expect(c.phone?.valid).toBe(false);
    expect(c.phone?.suggestion?.e164).toBe('+918862921256');
    expect(c.seniority).toBe('Executive');
    const us = await runChecks({ email: null, emailNormalized: null, phone: '+14155552671', phoneNormalized: '+14155552671', jobTitle: null, fullName: 'Y', state: 'CA', country: 'USA' });
    expect(us.phone?.valid).toBe(true);
    expect(us.phone?.suggestion).toBeNull();
  });
});

describe('ask AI scrubbing', () => {
  it('removes contact details from answers', async () => {
    const { scrubContacts } = await import('@/server/services/company-ask');
    const out = scrubContacts('Call +1 (303) 555-0100 or email info@peakroof.com, see https://peakroof.com and www.peakroof.com — or peakroof.com.');
    expect(out).not.toMatch(/\d{3}|@|https?:|www\.|peakroof\.com/);
    expect(scrubContacts('They have 120 employees and were founded in 2004.')).toBe('They have 120 employees and were founded in 2004.');
  });
});

describe('company names', () => {
  it('turns domains and page titles into clean names', async () => {
    const { cleanCompanyName } = await import('@/lib/business');
    expect(cleanCompanyName('skinpsyche.com')).toBe('Skinpsyche');
    expect(cleanCompanyName('https://www.peak-roofing.com/')).toBe('Peak Roofing');
    expect(cleanCompanyName('Akshar Eye Clinic - Best Eye Hospital in Mumbai For Cataract Surgery and Lasik Surgery | Eye Treatment Specialist in Malad', 'akshareyeclinic.com')).toBe('Akshar Eye Clinic');
    expect(cleanCompanyName('Home | Summit Roofing Co.', 'summitroofing.com')).toBe('Summit Roofing Co.');
    expect(cleanCompanyName('NextGenSearches')).toBe('NextGenSearches');
    expect(cleanCompanyName('Marsil Exports')).toBe('Marsil Exports');
  });
});
