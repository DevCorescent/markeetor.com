import { describe, expect, it } from 'vitest';
import { canonical, closest, emptyCriteria, findValues, normaliseNumbers, sanitize, understand, type Criteria, type Vocab } from '@/server/services/finder-nlu';

const V = (xs: string[]) => xs.map((value, i) => ({ value, count: 100 - i }));
const vocab: Vocab = {
  industries: V(['Real Estate', 'Insurance', 'Healthcare', 'Solar & Energy', 'Financial Services', 'Education', 'Automotive', 'Hospitality', 'Retail', 'IT Development', 'Construction', 'Manufacturing', 'Logistics', 'Management Consulting', 'Pharmaceuticals', 'Fashion & Apparel', 'Legal Services']),
  countries: V(['India', 'United States', 'United Kingdom', 'Canada', 'United Arab Emirates']),
  states: V(['Maharashtra', 'Karnataka', 'Delhi', 'Tamil Nadu', 'Kerala', 'Gujarat', 'Uttar Pradesh', 'California', 'New York', 'Texas', 'Telangana']),
  cities: V(['Mumbai', 'Pune', 'Bengaluru', 'Delhi', 'Chennai', 'Hyderabad', 'Gurugram', 'Ahmedabad', 'Los Angeles', 'New York', 'Kochi']),
  sources: V(['Website Form', 'Facebook Ads', 'Trade Show']),
  campaigns: V(['Diwali Promo 2026']),
  caps: { scored: true, titled: true },
};
const u = (m: string, prev: Partial<Criteria> = {}) => understand(m, vocab, { ...emptyCriteria(), ...prev }, null);
const c = (m: string, prev: Partial<Criteria> = {}) => u(m, prev).criteria;

describe('numbers', () => {
  it('normalises numbers written in words, thousands and lakhs', () => {
    expect(normaliseNumbers('two hundred fifty leads')).toBe('250 leads');
    expect(normaliseNumbers('a hundred leads')).toBe('100 leads');
    expect(normaliseNumbers('budget 1.5k')).toBe('budget 1500');
    expect(normaliseNumbers('2,000 leads')).toBe('2000 leads');
    expect(normaliseNumbers('2 lakh')).toBe('200000');
    expect(normaliseNumbers('a dozen leads')).toBe('12 leads');
  });
  it('reads quantities, scores, budgets and recency', () => {
    expect(c('I need fifty leads').quantity).toBe(50);
    expect(c('get me 1k solar leads').quantity).toBe(1000);
    expect(c('show me 25').quantity).toBe(25);
    expect(c('score 70+').minScore).toBe(70);
    expect(c('leads with score above 75').minScore).toBe(75);
    expect(c('80 plus score').minScore).toBe(80);
    expect(c('score below 40')).toMatchObject({ maxScore: 40, minScore: null });
    expect(c('budget ₹5,000 for insurance leads')).toMatchObject({ budget: 5000, industries: ['Insurance'], quantity: null });
    expect(c('under $200').budget).toBe(200);
    expect(c('within 3000 rupees').budget).toBe(3000);
    expect(c('score under 50').budget).toBeNull();
    expect(c('added in the last 2 weeks').addedWithinDays).toBe(14);
    expect(c('leads from the past 3 days').addedWithinDays).toBe(3);
    expect(c('leads added this month').addedWithinDays).toBe(30);
  });
});

describe('places', () => {
  it('maps aliases, cities and abbreviations onto the catalog', () => {
    expect(c('real estate leads in Bangalore').cities).toEqual(['Bengaluru']);
    expect(c('builders in bombay')).toMatchObject({ cities: ['Mumbai'], industries: ['Real Estate'] });
    expect(c('leads in gurgaon').cities).toEqual(['Gurugram']);
    expect(c('clinics in Pune and Chennai').cities.sort()).toEqual(['Chennai', 'Pune']);
    expect(c('leads from USA').countries).toEqual(['United States']);
    expect(c('UAE companies').countries).toEqual(['United Arab Emirates']);
    expect(c('leads in UP').states).toEqual(['Uttar Pradesh']);
    expect(c('I am looking for leads up to 50').states).toEqual([]); // lowercase "up" is a word, not Uttar Pradesh
    expect(c('leads in Delhi NCR')).toMatchObject({ states: ['Delhi'], cities: [] }); // state wins over the same-named city
    expect(c('leads in kerela').states).toEqual(['Kerala']); // typo
  });
  it('says when a country has no leads', () => {
    expect(u('leads in Brazil').intent.unavailable).toEqual(['Brazil']);
  });
});

describe('industries', () => {
  it('understands synonyms, niches and typos', () => {
    expect(c('property dealers').industries).toEqual(['Real Estate']);
    expect(c('car dealerships in texas')).toMatchObject({ industries: ['Automotive'], states: ['Texas'] });
    expect(c('NBFC and lending companies').industries).toEqual(['Financial Services']);
    expect(c('pharma companies').industries).toContain('Pharmaceuticals');
    expect(c('manufacturers in gujarat')).toMatchObject({ industries: ['Manufacturing'], states: ['Gujarat'] });
    expect(c('transporters and courier companies').industries).toEqual(['Logistics']);
    expect(c('law firms').industries).toEqual(['Legal Services']);
    expect(c('helthcare leads').industries).toEqual(['Healthcare']);
    expect(c('garment exporters').industries).toEqual(['Fashion & Apparel']);
  });
  it('never mistakes job roles for industries', () => {
    const x = c('managers and directors in hospitality');
    expect(x.industries).toEqual(['Hospitality']); // not "Management Consulting"
    expect(x.seniority.sort()).toEqual(['Director', 'Manager']);
    expect(c('owners of retail shops').industries).toEqual(['Retail']);
  });
});

describe('people & must-haves', () => {
  it('reads seniority', () => {
    expect(c('decision makers').seniority.sort()).toEqual(['Director', 'Executive']);
    expect(c('MDs and proprietors').seniority).toEqual(['Executive']);
    expect(c('managing directors of manufacturing firms')).toMatchObject({ seniority: ['Executive'], industries: ['Manufacturing'] });
    expect(c('general managers').seniority).toEqual(['Director']);
    expect(c('VPs and heads of sales').seniority).toEqual(['Director']);
  });
  it('reads must-haves', () => {
    expect(c('with mobile numbers')).toMatchObject({ needPhone: true });
    expect(c('with whatsapp')).toMatchObject({ needPhone: true });
    expect(c('need email ids')).toMatchObject({ needEmail: true });
    expect(c('with full contact details')).toMatchObject({ needPhone: true, needEmail: true });
    expect(c('exclusive leads never sold before').freshOnly).toBe(true);
    expect(c('hot leads').minScore).toBe(80);
    expect(c('good quality leads').minScore).toBe(65);
  });
});

describe('conversation', () => {
  it('excludes with not / except / no', () => {
    const a = c('real estate in India but not in Kerala');
    expect(a).toMatchObject({ industries: ['Real Estate'], countries: ['India'], excludeStates: ['Kerala'], states: [] });
    expect(c('all industries except insurance')).toMatchObject({ excludeIndustries: ['Insurance'], industries: [] });
    expect(c('no real estate, healthcare only')).toMatchObject({ excludeIndustries: ['Real Estate'], industries: ['Healthcare'] });
    expect(c('leads outside Mumbai').excludeCities).toEqual(['Mumbai']);
    expect(c('leads without phone numbers').needPhone).toBe(false);
    expect(c('not sure, any is fine').excludeIndustries).toEqual([]);
  });
  it('replaces with instead / what about, adds with and', () => {
    expect(c('what about Canada?', { countries: ['United States'] }).countries).toEqual(['Canada']);
    expect(c('Pune instead', { cities: ['Mumbai'] }).cities).toEqual(['Pune']);
    expect(c('switch to Karnataka', { states: ['Maharashtra'], cities: ['Mumbai'] })).toMatchObject({ states: ['Karnataka'], cities: [] });
    expect(c('also Chennai', { cities: ['Mumbai'] }).cities.sort()).toEqual(['Chennai', 'Mumbai']);
    expect(c('only healthcare', { industries: ['Insurance', 'Healthcare'] }).industries).toEqual(['Healthcare']);
  });
  it('removes filters on request', () => {
    expect(c('remove the phone filter', { needPhone: true }).needPhone).toBe(false);
    expect(c('any location is fine', { countries: ['India'], cities: ['Pune'] })).toMatchObject({ countries: [], cities: [] });
    expect(c('drop the score', { minScore: 80 }).minScore).toBeNull();
    expect(c('clear all filters', { industries: ['Retail'], needPhone: true })).toMatchObject({ industries: [], needPhone: false });
    expect(u('start over').intent.reset).toBe(true);
  });
  it('handles a full realistic request', () => {
    const x = c('Find 100 fresh decision makers in solar companies in Maharashtra except Mumbai, with phone numbers, score 70+, added last 2 weeks, budget ₹10,000');
    expect(x).toMatchObject({ quantity: 100, freshOnly: true, industries: ['Solar & Energy'], states: ['Maharashtra'], excludeCities: ['Mumbai'], needPhone: true, minScore: 70, addedWithinDays: 14, budget: 10000 });
    expect(x.seniority.sort()).toEqual(['Director', 'Executive']);
  });
});

describe('catalog mapping (for AI output)', () => {
  it('maps near-misses to canonical values and drops unknowns', () => {
    expect(canonical('bangalore', vocab.cities, 'place')).toBe('Bengaluru');
    expect(canonical('real-estate', vocab.industries, 'industry')).toBe('Real Estate');
    expect(canonical('Insurence', vocab.industries, 'industry')).toBe('Insurance');
    expect(canonical('Atlantis', vocab.countries, 'place')).toBeNull();
    const s = sanitize({ ...emptyCriteria(), industries: ['real estate', 'Underwater Basket Weaving'], cities: ['bombay'], excludeStates: ['kerala'] }, vocab);
    expect(s).toMatchObject({ industries: ['Real Estate'], cities: ['Mumbai'], excludeStates: ['Kerala'] });
  });
  it('suggests the closest values and finds values for the AI', () => {
    expect(closest('cement', vocab.industries)).toContain('Construction');
    expect(findValues('bang', vocab.cities, 'place')[0]?.value).toBe('Bengaluru');
    expect(findValues('property', vocab.industries, 'industry')[0]?.value).toBe('Real Estate');
  });
});
