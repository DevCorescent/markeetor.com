import { describe, expect, it } from 'vitest';
import { planAllocation, type PlanLead, type PlanTarget } from '@/server/services/allocation';

const leads = (n: number, f: (i: number) => Partial<PlanLead> = () => ({})): PlanLead[] =>
  Array.from({ length: n }, (_, i) => ({ id: `l${i}`, country: 'United States', state: null, industry: 'Retail', campaign: null, score: 50, ...f(i) }));
const target = (id: string, p: Partial<PlanTarget> = {}): PlanTarget => ({ organizationId: id, weight: 1, capacity: 1000, regions: [], industries: [], campaigns: [], minScore: null, maxScore: null, ...p });
const counts = (plan: ReturnType<typeof planAllocation>) => Object.fromEntries(plan.perTarget);

describe('allocation planner', () => {
  it('EQUAL splits evenly and assigns every lead exactly once', () => {
    const p = planAllocation('EQUAL', leads(9), [target('a'), target('b'), target('c')]);
    expect(counts(p)).toEqual({ a: 3, b: 3, c: 3 });
    expect(new Set(p.assignments.keys()).size).toBe(9);
  });

  it('never exceeds remaining capacity and reports the overflow', () => {
    const p = planAllocation('EQUAL', leads(10), [target('a', { capacity: 2 }), target('b', { capacity: 3 })]);
    expect(counts(p)).toEqual({ a: 2, b: 3 });
    expect(p.unassigned).toHaveLength(5);
    expect(p.unassigned[0].reason).toMatch(/capacity/);
  });

  it('CUSTOM honours requested quantities, bounded by capacity', () => {
    const p = planAllocation('CUSTOM', leads(20), [target('a', { quantity: 5 }), target('b', { quantity: 8, capacity: 6 }), target('c', { quantity: 0 })]);
    expect(counts(p)).toEqual({ a: 5, b: 6, c: 0 });
    expect(p.unassigned).toHaveLength(9);
  });

  it('WEIGHTED is proportional to weights', () => {
    const p = planAllocation('WEIGHTED', leads(60), [target('a', { weight: 3 }), target('b', { weight: 2 }), target('c', { weight: 1 })]);
    expect(counts(p)).toEqual({ a: 30, b: 20, c: 10 });
  });

  it('CAPACITY sends leads to the least-loaded client first', () => {
    const p = planAllocation('CAPACITY', leads(4), [target('a', { capacity: 1 }), target('b', { capacity: 10 })]);
    expect(counts(p).b).toBeGreaterThanOrEqual(3);
  });

  it('GEOGRAPHY only matches configured regions and explains misses', () => {
    const ls = leads(6, (i) => ({ country: i < 4 ? 'India' : 'Canada' }));
    const p = planAllocation('GEOGRAPHY', ls, [target('in', { regions: ['india'] }), target('us', { regions: ['United States'] })]);
    expect(counts(p)).toEqual({ in: 4, us: 0 });
    expect(p.unassigned.every((u) => /geography/.test(u.reason))).toBe(true);
  });

  it('SCORE routes by score range, highest scores first', () => {
    const ls = leads(4, (i) => ({ score: [10, 90, 55, 80][i] }));
    const p = planAllocation('SCORE', ls, [target('hot', { minScore: 75 }), target('warm', { minScore: 40, maxScore: 74 })]);
    expect(p.assignments.get('l1')).toBe('hot');
    expect(p.assignments.get('l3')).toBe('hot');
    expect(p.assignments.get('l2')).toBe('warm');
    expect(p.assignments.has('l0')).toBe(false);
  });

  it('ROUND_ROBIN offset rotates the starting client between runs', () => {
    const a = planAllocation('ROUND_ROBIN', leads(1), [target('x'), target('y')], { offset: 0 });
    const b = planAllocation('ROUND_ROBIN', leads(1), [target('x'), target('y')], { offset: 1 });
    expect(a.assignments.get('l0')).toBe('x');
    expect(b.assignments.get('l0')).toBe('y');
  });

  it('with no targets nothing is assigned', () => {
    expect(planAllocation('EQUAL', leads(3), []).unassigned).toHaveLength(3);
  });
});
