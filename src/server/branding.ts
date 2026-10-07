import { getSetting, type BrandAsset } from './settings';

export const BRAND_ASSET_KINDS = ['logo', 'logoDark', 'favicon', 'ogImage'] as const;
export type BrandAssetKind = (typeof BRAND_ASSET_KINDS)[number];

export const isBrandAssetKind = (k: string): k is BrandAssetKind => (BRAND_ASSET_KINDS as readonly string[]).includes(k);

/** Public, cache-busted URL for an uploaded brand file (the version changes on every upload). */
export const brandAssetUrl = (kind: BrandAssetKind, a: BrandAsset | null) => (a ? `/api/v1/branding/${kind}?v=${a.v}` : null);

export type Branding = {
  productName: string;
  shortName: string;
  tagline: string;
  showNameWithLogo: boolean;
  supportEmail: string;
  /** Main logo, used in both themes unless a dark-theme variant exists. */
  logoUrl: string | null;
  /** Optional variant (light artwork) shown in the dark theme. */
  logoDarkUrl: string | null;
  faviconUrl: string;
  ogImageUrl: string | null;
};

/** Everything the UI needs to render the white-labelled product name, logo and icons. */
export async function getBranding(): Promise<Branding> {
  const [b, a] = await Promise.all([getSetting('branding'), getSetting('branding.assets')]);
  return {
    productName: b.productName,
    shortName: b.shortName,
    tagline: b.tagline,
    showNameWithLogo: b.showNameWithLogo,
    supportEmail: b.supportEmail,
    logoUrl: brandAssetUrl('logo', a.logo),
    logoDarkUrl: brandAssetUrl('logoDark', a.logoDark),
    faviconUrl: brandAssetUrl('favicon', a.favicon) ?? `/api/v1/branding/favicon?d=${encodeURIComponent(b.shortName)}`,
    ogImageUrl: brandAssetUrl('ogImage', a.ogImage),
  };
}

/** Product name for server-generated text (emails, MFA issuer, reports). Never throws. */
export async function productName() {
  try {
    return (await getSetting('branding')).productName;
  } catch {
    return 'markeetor.com';
  }
}

/** Monogram favicon used until a custom favicon is uploaded. */
export function defaultFaviconSvg(shortName: string) {
  const text = shortName.replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase() || 'M';
  const size = text.length > 2 ? 10.5 : 13;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><style>rect{fill:#0b0b0b}text{fill:#fff}@media (prefers-color-scheme:dark){rect{fill:#fafafa}text{fill:#000}}</style><rect width="32" height="32" rx="7"/><text x="16" y="21" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-weight="700" font-size="${size}">${text}</text></svg>`;
}

/** Branding + appearance needed by the app shell. */
export async function shellBranding() {
  const [b, appearance] = await Promise.all([getBranding(), getSetting('appearance')]);
  return {
    mark: { productName: b.productName, shortName: b.shortName, tagline: b.tagline, logoUrl: b.logoUrl, logoDarkUrl: b.logoDarkUrl, showNameWithLogo: b.showNameWithLogo },
    allowThemeChoice: appearance.allowUserChoice,
  };
}
