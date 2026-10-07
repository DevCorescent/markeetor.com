import type { Prisma } from '@prisma/client';
import type { Condition, Filter, FilterField } from '@/lib/filters';

type Builder<W> = (c: Condition) => W | null;

const days = (n: unknown) => {
  const v = Number(n);
  return Number.isFinite(v) && v >= 0 && v <= 3650 ? new Date(Date.now() - v * 86400_000) : null;
};
const date = (v: unknown) => {
  if (typeof v !== 'string' || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const strArr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 200) : []);

/** Generic compiler from a whitelisted condition into a Prisma where fragment for a scalar column. */
function scalar(column: string, type: FilterField['type'], c: Condition, opts: { nullable?: boolean; enumValues?: readonly string[]; insensitive?: boolean } = {}): Record<string, unknown> | null {
  const set = (cond: unknown) => ({ [column]: cond });
  const v = c.value;
  switch (type) {
    case 'text': {
      const s = typeof v === 'string' ? v.trim().slice(0, 200) : '';
      if (c.op === 'empty') return { OR: [set(null), set('')] };
      if (c.op === 'not_empty') return { AND: [{ NOT: set(null) }, { NOT: set('') }] };
      if (!s) return null;
      if (c.op === 'contains') return set({ contains: s, mode: 'insensitive' });
      if (c.op === 'eq') return set({ equals: s, mode: 'insensitive' });
      if (c.op === 'neq') return { NOT: set({ equals: s, mode: 'insensitive' }) };
      return null;
    }
    case 'enum': {
      if (c.op === 'empty') return set(null);
      if (c.op === 'not_empty') return { NOT: set(null) };
      let vals = strArr(v);
      if (opts.enumValues) vals = vals.filter((x) => opts.enumValues!.includes(x));
      if (!vals.length) return null;
      if (c.op === 'in') return set({ in: vals });
      if (c.op === 'not_in') return opts.nullable ? { OR: [set({ notIn: vals }), set(null)] } : set({ notIn: vals });
      return null;
    }
    case 'number': {
      const n = Number(v);
      if (!Number.isFinite(n)) return null;
      if (c.op === 'gte') return set({ gte: n });
      if (c.op === 'lte') return set({ lte: n });
      if (c.op === 'eq') return set({ equals: n });
      return null;
    }
    case 'date': {
      if (c.op === 'empty') return set(null);
      if (c.op === 'not_empty') return { NOT: set(null) };
      if (c.op === 'after') { const d = date(v); return d ? set({ gte: d }) : null; }
      if (c.op === 'before') { const d = date(v); return d ? set({ lt: d }) : null; }
      if (c.op === 'last_days') { const d = days(v); return d ? set({ gte: d }) : null; }
      if (c.op === 'older_days') { const d = days(v); return d ? set({ lt: d }) : null; }
      return null;
    }
    case 'boolean':
      return null;
  }
}

// ── Master leads (platform) ─────────────────────────────────────────

export const LEAD_ENUMS = {
  priority: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'],
  quality: ['VALID', 'INVALID'],
  allocationStatus: ['UNALLOCATED', 'PENDING', 'ALLOCATED'],
  clientStatus: ['NEW', 'CONTACTED', 'QUALIFIED', 'NEGOTIATION', 'CONVERTED', 'LOST'],
} as const;

const LEAD_BUILDERS: Record<string, Builder<Prisma.LeadWhereInput>> = {
  fullName: (c) => scalar('fullName', 'text', c),
  company: (c) => scalar('company', 'text', c),
  email: (c) => scalar('emailNormalized', 'text', { ...c, value: typeof c.value === 'string' ? c.value.toLowerCase() : c.value }),
  phone: (c) => scalar('phoneNormalized', 'text', { ...c, value: typeof c.value === 'string' ? c.value.replace(/[^\d+]/g, '') : c.value }),
  jobTitle: (c) => scalar('jobTitle', 'text', c),
  city: (c) => scalar('city', 'text', c),
  state: (c) => scalar('state', 'text', c),
  country: (c) => scalar('country', 'enum', c, { nullable: true }),
  industry: (c) => scalar('industry', 'enum', c, { nullable: true }),
  source: (c) => scalar('source', 'enum', c, { nullable: true }),
  campaign: (c) => scalar('campaign', 'enum', c, { nullable: true }),
  score: (c) => scalar('score', 'number', c),
  priority: (c) => scalar('priority', 'enum', c, { enumValues: LEAD_ENUMS.priority }),
  quality: (c) => scalar('quality', 'enum', c, { enumValues: LEAD_ENUMS.quality }),
  allocationStatus: (c) => scalar('allocationStatus', 'enum', c, { enumValues: LEAD_ENUMS.allocationStatus }),
  clientStatus: (c) => scalar('clientStatus', 'enum', c, { enumValues: LEAD_ENUMS.clientStatus, nullable: true }),
  assignedOrganizationId: (c) => scalar('assignedOrganizationId', 'enum', c, { nullable: true }),
  importBatchId: (c) => scalar('importBatchId', 'enum', c, { nullable: true }),
  createdAt: (c) => scalar('createdAt', 'date', c),
  lastActivityAt: (c) => scalar('lastActivityAt', 'date', c),
  nextFollowUpAt: (c) => scalar('nextFollowUpAt', 'date', c),
  tag: (c) => {
    const ids = strArr(c.value);
    if (c.op === 'empty') return { tags: { none: {} } };
    if (c.op === 'not_empty') return { tags: { some: {} } };
    if (!ids.length) return null;
    return c.op === 'not_in' ? { tags: { none: { tagId: { in: ids } } } } : { tags: { some: { tagId: { in: ids } } } };
  },
  duplicate: (c) => (c.op === 'true' ? { NOT: { duplicateOfId: null } } : c.op === 'false' ? { duplicateOfId: null } : null),
  /** AI enrichment state: `empty` = never researched, otherwise the given statuses. */
  enrichment: (c) => {
    if (c.op === 'empty') return { enrichment: { is: null } };
    if (c.op === 'not_empty') return { enrichment: { isNot: null } };
    const st = strArr(c.value).filter((x) => ['QUEUED', 'RUNNING', 'DONE', 'PARTIAL', 'FAILED', 'SKIPPED'].includes(x));
    if (!st.length) return null;
    return c.op === 'not_in' ? { OR: [{ enrichment: { is: null } }, { enrichment: { status: { notIn: st as never } } }] } : { enrichment: { status: { in: st as never } } };
  },
  /** Free-text business keyword: matches the industry or what enrichment learned about the company (never names). */
  keyword: (c) => {
    const words = (Array.isArray(c.value) ? c.value : [c.value]).map((v) => String(v ?? '').trim().toLowerCase()).filter((v) => v.length >= 2).slice(0, 5);
    if (!words.length) return null;
    return { AND: words.map((w) => ({ OR: [{ industry: { contains: w, mode: 'insensitive' as const } }, { enrichment: { searchText: { contains: w } } }] })) };
  },
  distributionCount: (c) => scalar('distributionCount', 'number', c),
  lastDistributedAt: (c) => scalar('lastDistributedAt', 'date', c),
  /** Leads that were (ever) allocated to any of these clients, or never to any of them. */
  everClient: (c) => {
    const ids = strArr(c.value);
    if (c.op === 'empty') return { assignments: { none: {} } };
    if (c.op === 'not_empty') return { assignments: { some: {} } };
    if (!ids.length) return null;
    return c.op === 'not_in' ? { assignments: { none: { organizationId: { in: ids } } } } : { assignments: { some: { organizationId: { in: ids } } } };
  },
};

export type LeadView = 'active' | 'archived' | 'all';

export function buildLeadWhere(filter: Filter, view: LeadView = 'active'): Prisma.LeadWhereInput {
  const and: Prisma.LeadWhereInput[] = [{ mergedIntoId: null }];
  if (view === 'active') and.push({ archivedAt: null });
  if (view === 'archived') and.push({ NOT: { archivedAt: null } });
  if (filter.q) {
    const q = filter.q;
    const digits = q.replace(/[^\d]/g, '');
    and.push({
      OR: [
        { fullName: { contains: q, mode: 'insensitive' } },
        { company: { contains: q, mode: 'insensitive' } },
        { emailNormalized: { contains: q.toLowerCase() } },
        ...(digits.length >= 4 ? [{ phoneNormalized: { contains: digits } }] : []),
      ],
    });
  }
  for (const c of filter.conditions) {
    // Own-property lookup only: keys like "__proto__" must not resolve to prototype members.
    const b = Object.hasOwn(LEAD_BUILDERS, c.field) ? LEAD_BUILDERS[c.field] : undefined;
    if (!b) continue; // unknown fields are ignored, never passed through
    const w = b(c);
    if (w) and.push(w);
  }
  return { AND: and };
}

export const LEAD_SORTS: Record<string, (desc: boolean) => Prisma.LeadOrderByWithRelationInput> = {
  fullName: (d) => ({ fullName: d ? 'desc' : 'asc' }),
  company: (d) => ({ company: { sort: d ? 'desc' : 'asc', nulls: 'last' } }),
  score: (d) => ({ score: d ? 'desc' : 'asc' }),
  createdAt: (d) => ({ createdAt: d ? 'desc' : 'asc' }),
  updatedAt: (d) => ({ updatedAt: d ? 'desc' : 'asc' }),
  source: (d) => ({ source: { sort: d ? 'desc' : 'asc', nulls: 'last' } }),
  country: (d) => ({ country: { sort: d ? 'desc' : 'asc', nulls: 'last' } }),
  priority: (d) => ({ priority: d ? 'desc' : 'asc' }),
  lastActivityAt: (d) => ({ lastActivityAt: { sort: d ? 'desc' : 'asc', nulls: 'last' } }),
  distributionCount: (d) => ({ distributionCount: d ? 'desc' : 'asc' }),
  lastDistributedAt: (d) => ({ lastDistributedAt: { sort: d ? 'desc' : 'asc', nulls: 'last' } }),
  industry: (d) => ({ industry: { sort: d ? 'desc' : 'asc', nulls: 'last' } }),
};

// ── Client leads (tenant projection) ────────────────────────────────

const CLIENT_BUILDERS: Record<string, Builder<Prisma.ClientLeadWhereInput>> = {
  fullName: (c) => scalar('fullName', 'text', c),
  company: (c) => scalar('company', 'text', c),
  jobTitle: (c) => scalar('jobTitle', 'text', c),
  city: (c) => scalar('city', 'text', c),
  country: (c) => scalar('country', 'enum', c, { nullable: true }),
  industry: (c) => scalar('industry', 'enum', c, { nullable: true }),
  source: (c) => scalar('source', 'enum', c, { nullable: true }),
  campaign: (c) => scalar('campaign', 'enum', c, { nullable: true }),
  status: (c) => scalar('status', 'enum', c, { enumValues: LEAD_ENUMS.clientStatus }),
  priority: (c) => scalar('priority', 'enum', c, { enumValues: LEAD_ENUMS.priority }),
  ownerId: (c) => scalar('ownerId', 'enum', c, { nullable: true }),
  stageId: (c) => scalar('stageId', 'enum', c, { nullable: true }),
  score: (c) => scalar('score', 'number', c),
  createdAt: (c) => scalar('createdAt', 'date', c),
  lastActivityAt: (c) => scalar('lastActivityAt', 'date', c),
  nextFollowUpAt: (c) => scalar('nextFollowUpAt', 'date', c),
  firstContactAt: (c) => scalar('firstContactAt', 'date', c),
  tag: (c) => {
    const ids = strArr(c.value);
    if (!ids.length) return null;
    return c.op === 'not_in' ? { tags: { none: { tagId: { in: ids } } } } : { tags: { some: { tagId: { in: ids } } } };
  },
};

export function buildClientLeadWhere(organizationId: string, filter: Filter, opts: { ownerOnly?: string | null; view?: LeadView }): Prisma.ClientLeadWhereInput {
  const and: Prisma.ClientLeadWhereInput[] = [{ organizationId }, { revokedAt: null }];
  const view = opts.view ?? 'active';
  if (view === 'active') and.push({ archivedAt: null });
  if (view === 'archived') and.push({ NOT: { archivedAt: null } });
  if (opts.ownerOnly) and.push({ ownerId: opts.ownerOnly });
  if (filter.q) {
    and.push({ OR: [{ fullName: { contains: filter.q, mode: 'insensitive' } }, { company: { contains: filter.q, mode: 'insensitive' } }] });
  }
  for (const c of filter.conditions) {
    const b = Object.hasOwn(CLIENT_BUILDERS, c.field) ? CLIENT_BUILDERS[c.field] : undefined;
    if (!b) continue;
    const w = b(c);
    if (w) and.push(w);
  }
  return { AND: and };
}

export const CLIENT_SORTS: Record<string, (desc: boolean) => Prisma.ClientLeadOrderByWithRelationInput> = {
  fullName: (d) => ({ fullName: d ? 'desc' : 'asc' }),
  company: (d) => ({ company: { sort: d ? 'desc' : 'asc', nulls: 'last' } }),
  score: (d) => ({ score: d ? 'desc' : 'asc' }),
  createdAt: (d) => ({ createdAt: d ? 'desc' : 'asc' }),
  status: (d) => ({ status: d ? 'desc' : 'asc' }),
  priority: (d) => ({ priority: d ? 'desc' : 'asc' }),
  nextFollowUpAt: (d) => ({ nextFollowUpAt: { sort: d ? 'desc' : 'asc', nulls: 'last' } }),
  lastActivityAt: (d) => ({ lastActivityAt: { sort: d ? 'desc' : 'asc', nulls: 'last' } }),
  dealValue: (d) => ({ dealValue: { sort: d ? 'desc' : 'asc', nulls: 'last' } }),
};

/** Safe lookup of a whitelisted sort by user-supplied id. */
export function pickSort<T>(table: Record<string, (desc: boolean) => T>, sort?: { id: string; desc: boolean } | null): T | null {
  return sort && Object.hasOwn(table, sort.id) ? table[sort.id](sort.desc) : null;
}
