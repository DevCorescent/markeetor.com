import { DEFAULT_CREDIT_SETTINGS } from '@/lib/credits';
import { DEFAULT_GROWTH } from '@/lib/growth';
import { DEFAULT_FINANCE } from '@/lib/finance';
import { DEFAULT_MARKETING } from '@/lib/marketing';
import { DEFAULT_PRICING } from '@/lib/pricing';
import { prisma } from './db';

export const SETTING_DEFAULTS = {
  'security.policy': {
    passwordMinLength: 12,
    lockoutThreshold: 5,
    lockoutMinutes: 15,
    sessionAbsoluteHours: 12,
    sessionIdleMinutes: 30,
    mfaRequiredForPlatform: true,
    stepUpMinutes: 10,
    revealsPerHour: 60,
    leadViewsPerHourAlert: 300,
    forbiddenBurstThreshold: 10,
    apiRequestsPerMinute: 600,
  },
  'audit.retention': { days: 365 },
  'distribution.policy': { largeBatchThreshold: 500, rollbackWindowHours: 72, maxBatchSize: 50_000 },
  'imports.policy': { fileRetentionDays: 7, rowDataRetentionDays: 30, maxRows: 200_000, defaultCountry: 'US' },
  'ai.config': { enabled: false, provider: null as string | null, allowLeadDataEgress: false },
  'dashboard.demoDataLabel': { enabled: false },
  branding: {
    productName: 'markeetor.com' as string,
    shortName: 'M' as string,
    tagline: 'Platform administration' as string,
    showNameWithLogo: true,
    supportEmail: '' as string,
  },
  /** Uploaded brand files; written only by the branding upload route. */
  'branding.assets': {
    logo: null as BrandAsset | null,
    logoDark: null as BrandAsset | null,
    favicon: null as BrandAsset | null,
    ogImage: null as BrandAsset | null,
  },
  seo: {
    siteUrl: '' as string,
    defaultTitle: '' as string,
    titleTemplate: '%s · {product}' as string,
    description: 'Lead distribution and CRM management platform' as string,
    keywords: [] as string[],
    allowIndexing: false,
    googleVerification: '' as string,
    bingVerification: '' as string,
    sitemapEnabled: true,
    sitemapPaths: ['/login'] as string[],
    twitterHandle: '' as string,
  },
  /** Lead marketplace pricing, free demo allowance and approval policy (edited in Admin → Marketplace). */
  pricing: DEFAULT_PRICING,
  /** Lead credits: packs, spend rules, expiry and payment instructions (Admin → Marketplace → Credits). */
  credits: DEFAULT_CREDIT_SETTINGS,
  /** Saved searches & auto-buy, lead quality guarantee, referrals, weekly reports (Admin → Marketplace → Growth). */
  growth: DEFAULT_GROWTH,
  /** Seller / GST details, invoice numbering and online payments (Admin → Finance). */
  finance: DEFAULT_FINANCE,
  /** Marketing tools: features per client, credit pricing, limits, quiet hours, moderation, providers (Admin → Marketing). */
  marketing: DEFAULT_MARKETING,
  /** AI lead enrichment (Lead repository → Enrichment). */
  'enrichment.policy': { autoOnImport: false, applyMode: 'empty' as 'empty' | 'overwrite' | 'none', minConfidence: 60, refreshDays: 30, maxPerDay: 5000, clientResearch: true, clientDailyLimit: 30, webResearch: true },
  /** The published onboarding form whose landing page is served at `/` (null = `/` goes to sign-in). */
  homepage: { formId: null as string | null },
  appearance: { defaultTheme: 'dark' as 'light' | 'dark' | 'system', allowUserChoice: true },
} as const;

export type BrandAsset = { v: number; type: string; ext: string; size: number };

export type SettingKey = keyof typeof SETTING_DEFAULTS;
export type SettingValue<K extends SettingKey> = { -readonly [P in keyof (typeof SETTING_DEFAULTS)[K]]: (typeof SETTING_DEFAULTS)[K][P] extends number ? number : (typeof SETTING_DEFAULTS)[K][P] extends boolean ? boolean : (typeof SETTING_DEFAULTS)[K][P] };

const cache = new Map<string, { at: number; value: unknown }>();
const TTL_MS = 15_000;

export async function getSetting<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as SettingValue<K>;
  const row = await prisma.platformSetting.findUnique({ where: { key } });
  const value = { ...SETTING_DEFAULTS[key], ...((row?.value as object) ?? {}) } as SettingValue<K>;
  cache.set(key, { at: Date.now(), value });
  return value;
}

export function invalidateSetting(key?: string) {
  if (key) cache.delete(key);
  else cache.clear();
}
