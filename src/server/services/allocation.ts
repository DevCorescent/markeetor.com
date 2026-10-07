import type { DistributionStrategy } from '@prisma/client';

/**
 * Pure allocation planner. Given candidate leads and eligible targets (with remaining capacity), decides
 * which organization receives each lead. No I/O — the distribution service enforces the plan
 * transactionally and re-checks capacity at execution time.
 */
export type PlanLead = { id: string; country: string | null; state: string | null; industry: string | null; campaign: string | null; score: number };

export type PlanTarget = {
  organizationId: string;
  name?: string;
  /** Requested quantity (CUSTOM strategy). */
  quantity?: number;
  weight: number;
  /** Remaining capacity under quotas. Infinity when quotas are not enforced. */
  capacity: number;
  regions: string[];
  industries: string[];
  campaigns: string[];
  minScore: number | null;
  maxScore: number | null;
};

export type Plan = {
  assignments: Map<string, string>;
  perTarget: Map<string, number>;
  unassigned: { leadId: string; reason: string }[];
};

const lc = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

export function matchesProfile(strategy: DistributionStrategy, lead: PlanLead, t: PlanTarget): boolean {
  switch (strategy) {
    case 'GEOGRAPHY':
      return t.regions.length > 0 && t.regions.some((r) => lc(r) === lc(lead.country) || lc(r) === lc(lead.state));
    case 'INDUSTRY':
      return t.industries.length > 0 && t.industries.some((i) => lc(i) === lc(lead.industry));
    case 'CAMPAIGN':
      return t.campaigns.length > 0 && t.campaigns.some((c) => lc(c) === lc(lead.campaign));
    case 'SCORE':
      return (t.minScore == null || lead.score >= t.minScore) && (t.maxScore == null || lead.score <= t.maxScore) && (t.minScore != null || t.maxScore != null);
    default:
      return true;
  }
}

/** Smooth weighted round-robin (nginx algorithm): deterministic, interleaved, proportional. */
class WeightedPicker {
  private current = new Map<string, number>();
  constructor(private targets: PlanTarget[]) {
    for (const t of targets) this.current.set(t.organizationId, 0);
  }
  pick(eligible: PlanTarget[], weightOf: (t: PlanTarget) => number): PlanTarget | null {
    let total = 0;
    let best: PlanTarget | null = null;
    for (const t of eligible) {
      const w = Math.max(0, weightOf(t));
      if (w <= 0) continue;
      total += w;
      const cur = (this.current.get(t.organizationId) ?? 0) + w;
      this.current.set(t.organizationId, cur);
      if (!best || cur > (this.current.get(best.organizationId) ?? 0)) best = t;
    }
    if (best) this.current.set(best.organizationId, (this.current.get(best.organizationId) ?? 0) - total);
    return best;
  }
}

/**
 * `blocked` maps a lead to organizations that must not receive it (e.g. clients that already had it).
 * Such leads go to another selected client, or stay unallocated with a clear reason.
 */
export function planAllocation(strategy: DistributionStrategy, leadsIn: PlanLead[], targets: PlanTarget[], opts: { offset?: number; blocked?: Map<string, Set<string>> } = {}): Plan {
  const assignments = new Map<string, string>();
  const perTarget = new Map<string, number>(targets.map((t) => [t.organizationId, 0]));
  const unassigned: Plan['unassigned'] = [];
  const remaining = new Map<string, number>(targets.map((t) => [t.organizationId, Math.max(0, t.capacity)]));
  const want = new Map<string, number>(targets.map((t) => [t.organizationId, strategy === 'CUSTOM' ? Math.max(0, Math.floor(t.quantity ?? 0)) : Infinity]));
  const hasRoom = (t: PlanTarget) => (remaining.get(t.organizationId) ?? 0) > 0 && (perTarget.get(t.organizationId) ?? 0) < (want.get(t.organizationId) ?? 0);
  const give = (leadId: string, t: PlanTarget) => {
    assignments.set(leadId, t.organizationId);
    perTarget.set(t.organizationId, (perTarget.get(t.organizationId) ?? 0) + 1);
    remaining.set(t.organizationId, (remaining.get(t.organizationId) ?? 0) - 1);
  };

  if (!targets.length) {
    return { assignments, perTarget, unassigned: leadsIn.map((l) => ({ leadId: l.id, reason: 'No eligible client organizations' })) };
  }

  const leads = strategy === 'SCORE' ? [...leadsIn].sort((a, b) => b.score - a.score) : leadsIn;
  const offset = Math.abs(opts.offset ?? 0) % targets.length;
  const rotated = [...targets.slice(offset), ...targets.slice(0, offset)];
  let rr = 0;
  const picker = new WeightedPicker(targets);

  for (const lead of leads) {
    let chosen: PlanTarget | null = null;
    const block = opts.blocked?.get(lead.id);
    const open = (t: PlanTarget) => hasRoom(t) && !block?.has(t.organizationId);
    if (block && targets.every((t) => block.has(t.organizationId))) {
      unassigned.push({ leadId: lead.id, reason: 'Every selected client already had this lead' });
      continue;
    }
    switch (strategy) {
      case 'EQUAL':
      case 'ROUND_ROBIN':
      case 'CUSTOM': {
        // Interleave across targets so each receives a comparable mix of the selection.
        for (let i = 0; i < rotated.length; i++) {
          const t = rotated[(rr + i) % rotated.length];
          if (open(t)) {
            chosen = t;
            rr = (rr + i + 1) % rotated.length;
            break;
          }
        }
        break;
      }
      case 'WEIGHTED':
        chosen = picker.pick(targets.filter(open), (t) => t.weight);
        break;
      case 'QUOTA':
        // Proportional to remaining quota headroom.
        chosen = picker.pick(targets.filter(open), (t) => Math.min(remaining.get(t.organizationId) ?? 0, 1_000_000));
        break;
      case 'CAPACITY': {
        // Least-loaded first: the target with the most remaining capacity right now.
        let best: PlanTarget | null = null;
        for (const t of targets) if (open(t) && (!best || (remaining.get(t.organizationId) ?? 0) > (remaining.get(best.organizationId) ?? 0))) best = t;
        chosen = best;
        break;
      }
      case 'GEOGRAPHY':
      case 'INDUSTRY':
      case 'CAMPAIGN':
      case 'SCORE': {
        const matches = targets.filter((t) => matchesProfile(strategy, lead, t));
        if (!matches.length) {
          unassigned.push({ leadId: lead.id, reason: `No client matches this lead's ${strategy.toLowerCase()}` });
          continue;
        }
        if (block && matches.every((t) => block.has(t.organizationId))) {
          unassigned.push({ leadId: lead.id, reason: 'Every matching client already had this lead' });
          continue;
        }
        chosen = picker.pick(matches.filter(open), (t) => Math.max(1, t.weight));
        break;
      }
    }
    if (chosen) give(lead.id, chosen);
    else unassigned.push({ leadId: lead.id, reason: strategy === 'CUSTOM' ? 'Requested quantities already fulfilled' : 'All eligible clients are at capacity' });
  }
  return { assignments, perTarget, unassigned };
}
