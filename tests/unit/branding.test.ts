import { describe, expect, it } from 'vitest';
import { defaultFaviconSvg } from '@/server/branding';
import { settingSchemas } from '@/server/services/governance';
import { assertSafeSvg, sniffImage } from '@/server/services/branding';

describe('brand asset checks', () => {
  it('identifies images by content, not by name', () => {
    expect(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBe('png');
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp');
    expect(sniffImage(Buffer.from([0, 0, 1, 0, 1, 0]))).toBe('ico');
    expect(sniffImage(Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('svg');
    expect(sniffImage(Buffer.from('MZ\x90\0 executable'))).toBeNull();
    expect(sniffImage(Buffer.from('<html><script>alert(1)</script></html>'))).toBeNull();
  });

  it('rejects active or externally-linked SVG content', () => {
    const ok = '<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"/></defs><rect fill="url(#g)" width="10" height="10"/><use href="#g"/></svg>';
    expect(() => assertSafeSvg(Buffer.from(ok))).not.toThrow();
    for (const bad of [
      '<svg><script>alert(1)</script></svg>',
      '<svg onload="alert(1)"></svg>',
      '<svg><a href="javascript:alert(1)">x</a></svg>',
      '<svg><image href="https://evil.test/x.png"/></svg>',
      '<svg><foreignObject><div/></foreignObject></svg>',
      '<svg><style>@import url(https://evil.test/a.css)</style></svg>',
      '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>',
    ]) expect(() => assertSafeSvg(Buffer.from(bad)), bad).toThrow(/scripts|external/);
  });

  it('builds a monogram favicon that cannot inject markup', () => {
    expect(defaultFaviconSvg('<b>')).toContain('>B<');
    expect(defaultFaviconSvg('ACME')).toContain('>ACM<');
  });
});

describe('SEO settings validation', () => {
  const seo = settingSchemas.seo;
  const valid = { siteUrl: 'https://crm.example.com/', defaultTitle: '', titleTemplate: '%s · {product}', description: 'x', keywords: [], allowIndexing: true, googleVerification: 'abc_DEF-123', bingVerification: '', sitemapEnabled: true, sitemapPaths: ['/login'], twitterHandle: '@acme' };
  it('normalises the site URL and accepts verification tokens', () => {
    expect(seo.parse(valid).siteUrl).toBe('https://crm.example.com');
  });
  it('rejects unsafe or malformed values', () => {
    expect(seo.safeParse({ ...valid, siteUrl: 'javascript:alert(1)' }).success).toBe(false);
    expect(seo.safeParse({ ...valid, googleVerification: '"><script>' }).success).toBe(false);
    expect(seo.safeParse({ ...valid, titleTemplate: 'No placeholder' }).success).toBe(false);
    expect(seo.safeParse({ ...valid, sitemapPaths: ['https://evil.test/'] }).success).toBe(false);
  });
});
