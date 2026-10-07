export const STRATEGY_INFO: Record<string, { label: string; description: string; manual: boolean }> = {
  EQUAL: { label: 'Distribute equally', description: 'Interleaves leads evenly across the selected clients, within each client’s remaining quota.', manual: true },
  CUSTOM: { label: 'Custom quantities', description: 'Each client receives exactly the quantity you enter (or fewer if its quota runs out).', manual: true },
  ROUND_ROBIN: { label: 'Round-robin', description: 'Rotates clients in order. Rules continue the rotation from where the previous run stopped.', manual: true },
  WEIGHTED: { label: 'Weighted', description: 'Proportional to each client’s weight (smooth weighted round-robin).', manual: true },
  QUOTA: { label: 'Quota-based', description: 'Proportional to each client’s remaining quota headroom.', manual: true },
  CAPACITY: { label: 'Capacity-aware', description: 'Each lead goes to whichever eligible client currently has the most free capacity.', manual: true },
  GEOGRAPHY: { label: 'Geographic', description: 'Matches lead country/state to each client’s configured regions.', manual: true },
  INDUSTRY: { label: 'Industry', description: 'Matches lead industry to each client’s configured industries.', manual: true },
  CAMPAIGN: { label: 'Campaign', description: 'Matches lead campaign to each client’s configured campaigns.', manual: true },
  SCORE: { label: 'Lead score', description: 'Matches lead score to each client’s score range; highest scores are placed first.', manual: true },
};
