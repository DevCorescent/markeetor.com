import { beforeAll, describe, expect, it } from 'vitest';
import robots from '@/app/robots';
import { GET as assetGET, POST as assetPOST, DELETE as assetDELETE } from '@/app/api/v1/branding/[kind]/route';
import { PUT as settingsPUT } from '@/app/api/v1/settings/route';
import { POST as stepUpPOST } from '@/app/api/v1/auth/step-up/route';
import { getBranding } from '@/server/branding';
import { invalidateSetting } from '@/server/settings';
import { cookieFor, ensureRoles, makeOrg, makeUser, PASSWORD, req } from '../helpers';

let cookie = '';

const upload = (kind: string, body: Buffer | string, name: string, c = cookie) => {
  const fd = new FormData();
  fd.append('file', new File([typeof body === 'string' ? body : new Uint8Array(body)], name));
  return assetPOST(new Request(`http://localhost:3100/api/v1/branding/${kind}`, { method: 'POST', body: fd, headers: { cookie: c, origin: 'http://localhost:3100', host: 'localhost:3100' } }), kindParam(kind));
};
const kindParam = (kind: string) => ({ params: Promise.resolve({ kind }) });
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

beforeAll(async () => {
  await ensureRoles();
  const owner = await makeUser('platform_owner', null);
  cookie = await cookieFor(owner.id);
  expect((await stepUpPOST(req('/x', { cookie, body: { password: PASSWORD } }))).status).toBe(200);
});

describe('branding', () => {
  it('uploads, serves (sandboxed, cache-busted) and removes a logo', async () => {
    const res = await upload('logo', PNG, 'logo.png');
    expect(res.status).toBe(200);
    const { url } = await res.json();
    expect(url).toMatch(/^\/api\/v1\/branding\/logo\?v=\d+$/);
    expect((await getBranding()).logoUrl).toBe(url);
    const served = await assetGET(new Request(`http://localhost:3100${url}`), kindParam('logo'));
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(served.headers.get('content-security-policy')).toMatch(/sandbox/);
    expect(served.headers.get('cache-control')).toMatch(/immutable/);
    expect(Buffer.from(await served.arrayBuffer()).equals(PNG)).toBe(true);
    expect((await assetDELETE(req('/x', { method: 'DELETE', cookie }), kindParam('logo'))).status).toBe(200);
    expect((await assetGET(new Request('http://localhost:3100/api/v1/branding/logo'), kindParam('logo'))).status).toBe(404);
  });

  it('rejects disguised files, scripted SVGs and non-admins', async () => {
    expect((await upload('logo', Buffer.from('MZ\x90\0binary'), 'logo.png')).status).toBe(415);
    expect((await upload('logo', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', 'logo.svg')).status).toBe(422);
    expect((await upload('ogImage', '<svg xmlns="http://www.w3.org/2000/svg"/>', 'og.svg')).status).toBe(415);
    const org = await makeOrg();
    const client = await makeUser('client_owner', org.id);
    expect((await upload('logo', PNG, 'logo.png', await cookieFor(client.id))).status).toBe(403);
  });

  it('serves a monogram favicon by default and applies product name changes', async () => {
    const put = await settingsPUT(req('/x', { method: 'PUT', cookie, body: { key: 'branding', value: { productName: 'Acme Leads', shortName: 'AL', tagline: 'Ops', showNameWithLogo: true, supportEmail: '' } } }));
    expect(put.status).toBe(200);
    expect((await getBranding()).productName).toBe('Acme Leads');
    const fav = await assetGET(new Request('http://localhost:3100/api/v1/branding/favicon'), kindParam('favicon'));
    expect(await fav.text()).toContain('>AL<');
  });

  it('robots.txt blocks everything until indexing is enabled, and never exposes private areas', async () => {
    invalidateSetting();
    expect(await robots()).toEqual({ rules: { userAgent: '*', disallow: '/' } });
    const seo = { siteUrl: 'https://crm.acme.test', defaultTitle: '', titleTemplate: '%s · {product}', description: 'CRM', keywords: [], allowIndexing: true, googleVerification: '', bingVerification: '', sitemapEnabled: true, sitemapPaths: ['/login'], twitterHandle: '' };
    expect((await settingsPUT(req('/x', { method: 'PUT', cookie, body: { key: 'seo', value: seo } }))).status).toBe(200);
    const r = await robots();
    const rules = r.rules as { allow: string; disallow: string[] };
    expect(rules.allow).toBe('/');
    expect(rules.disallow).toEqual(expect.arrayContaining(['/admin', '/app', '/account', '/api/']));
    expect(r.sitemap).toBe('https://crm.acme.test/sitemap.xml');
    await settingsPUT(req('/x', { method: 'PUT', cookie, body: { key: 'seo', value: { ...seo, allowIndexing: false } } }));
  });
});
