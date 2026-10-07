import { describe, expect, it } from 'vitest';
import { DEFAULT_PRICING, defaultDynamicPricing, describeDynamic, priceLead, pricingSchema, type DynamicPricing, type PricedLead } from '@/lib/pricing';

const NOW = Date.UTC(2026, 9, 1);
const daysAgo = (n: number) => new Date(NOW - n * 86400_000);
const lead = (extra: Partial<PricedLead> = {}): PricedLead => ({ country: 'India', state: null, industry: 'Software', source: null, campaign: null, score: 50, priority: 'MEDIUM', createdAt: daysAgo(0), distributionCount: 0, ...extra });
const none: DynamicPricing['attributes'] = defaultDynamicPricing().attributes.map((a) => ({ ...a, enabled: false }));
const cfg = (d: Partial<DynamicPricing> = {}, extra: { basePrice?: number; minPrice?: number } = {}) => ({ basePrice: 10, minPrice: 0, rules: [], dynamic: { ...defaultDynamicPricing(), attributes: none, research: { enabled: false, maxPct: 0, minConfidence: 0 }, age: { ...defaultDynamicPricing().age, enabled: false }, transfers: { ...defaultDynamicPricing().transfers, enabled: false }, ...d }, ...extra });

describe('dynamic lead pricing', () => {
  it('adds a % of the standard price for each kind of information the lead has', () => {
    const p = cfg({ attributes: [{ key: 'businessEmail', enabled: true, pct: 20 }, { key: 'phone', enabled: true, pct: 15 }, { key: 'website', enabled: false, pct: 50 }] });
    const r = priceLead(lead({ info: { businessEmail: true, phone: true, website: true } }), p, NOW);
    expect(r.cents).toBe(1350);
    expect(r.steps.map((s) => [s.kind, s.deltaCents])).toEqual([['base', 1000], ['info', 200], ['info', 150]]);
    // Missing information adds nothing.
    expect(priceLead(lead({ info: { phone: false } }), p, NOW).cents).toBe(1000);
  });

  it('scales the research premium by confidence and ignores weak research', () => {
    const p = cfg({ research: { enabled: true, maxPct: 20, minConfidence: 50 } });
    expect(priceLead(lead({ info: { researchConfidence: 80 } }), p, NOW).cents).toBe(1160);
    expect(priceLead(lead({ info: { researchConfidence: 40 } }), p, NOW).cents).toBe(1000);
    expect(priceLead(lead({ info: { researchConfidence: null } }), p, NOW).cents).toBe(1000);
  });

  it('depreciates with age in steps after a grace period, never below the floor', () => {
    const p = cfg({ age: { enabled: true, graceDays: 7, everyDays: 30, pct: 10, floorPct: 50 } });
    expect(priceLead(lead({ createdAt: daysAgo(5) }), p, NOW).cents).toBe(1000);
    expect(priceLead(lead({ createdAt: daysAgo(20) }), p, NOW).cents).toBe(900); // 1 period
    expect(priceLead(lead({ createdAt: daysAgo(40) }), p, NOW).cents).toBe(810); // 2 periods, compounding
    expect(priceLead(lead({ createdAt: daysAgo(900) }), p, NOW).cents).toBe(500); // floor
    expect(priceLead(lead({ createdAt: daysAgo(900) }), p, NOW).steps.at(-1)?.detail).toMatch(/floor 50%/);
  });

  it('depreciates for every previous sale, never below the floor', () => {
    const p = cfg({ transfers: { enabled: true, pct: 20, floorPct: 40 } });
    expect(priceLead(lead({ distributionCount: 1 }), p, NOW).cents).toBe(800);
    expect(priceLead(lead({ distributionCount: 2 }), p, NOW).cents).toBe(640);
    expect(priceLead(lead({ distributionCount: 9 }), p, NOW).cents).toBe(400);
  });

  it('applies information first, then custom rules, then depreciation, then min/max', () => {
    const p = {
      ...cfg({ attributes: [{ key: 'email', enabled: true, pct: 50 }], age: { enabled: true, graceDays: 0, everyDays: 30, pct: 50, floorPct: 10 }, maxPrice: 12 }, { minPrice: 3 }),
      rules: [{ id: 'x', name: 'Double', enabled: true, conditions: [], action: 'MULTIPLY' as const, amount: 200 }],
    };
    // 10 → +50% = 15 → ×2 = 30 → age −50% = 15 → max 12
    const r = priceLead(lead({ createdAt: daysAgo(10), info: { email: true } }), p, NOW);
    expect(r.cents).toBe(1200);
    expect(r.steps.map((s) => s.kind)).toEqual(['base', 'info', 'rule', 'age', 'limit']);
    expect(r.applied).toEqual(['Information value', 'Double', 'Age']);
    // Minimum still wins over heavy depreciation.
    const cheap = priceLead(lead({ createdAt: daysAgo(400) }), { ...p, rules: [] }, NOW);
    expect(cheap.cents).toBe(300);
  });

  it('ignores everything dynamic when switched off, and old saved settings get sensible defaults', () => {
    const off = cfg({ enabled: false, attributes: [{ key: 'email', enabled: true, pct: 50 }], transfers: { enabled: true, pct: 50, floorPct: 0 } });
    expect(priceLead(lead({ distributionCount: 3, info: { email: true } }), off, NOW).cents).toBe(1000);
    const legacy = pricingSchema.parse({ ...DEFAULT_PRICING, dynamic: undefined });
    expect(legacy.dynamic).toMatchObject({ enabled: true, age: { floorPct: 40 }, transfers: { pct: 15 } });
    expect(legacy.dynamic.attributes.length).toBeGreaterThan(10);
    expect(describeDynamic(legacy.dynamic).map((x) => x.name)).toEqual(['Information value', 'Research quality', 'Older leads cost less', 'Previously sold leads cost less']);
  });
});
