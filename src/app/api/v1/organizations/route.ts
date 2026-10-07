import { z } from 'zod';
import { paginationQuery, route } from '@/server/api';
import { createOrganization, createOrgInput, listOrganizations } from '@/server/services/organizations';

export const GET = route(
  { perm: 'orgs.read', apiKey: true, query: paginationQuery.extend({ q: z.string().trim().max(100).optional(), status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED', 'ARCHIVED']).optional() }) },
  async ({ query }) => listOrganizations(query),
);

export const POST = route({ perm: 'orgs.create', body: createOrgInput }, async ({ ctx, body }) => createOrganization(ctx, body));
