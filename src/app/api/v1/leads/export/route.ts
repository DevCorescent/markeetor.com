import { z } from 'zod';
import { filterSchema } from '@/lib/filters';
import { route } from '@/server/api';
import { exportLeadsCsv } from '@/server/services/leads';

/** Administrative export only: platform scope, `leads.export`, recent step-up, rate limited, audited. No equivalent exists for client workspaces. */
export const POST = route(
  {
    perm: 'leads.export',
    stepUp: true,
    rate: { bucket: 'lead-export', limit: 5, windowSec: 3600 },
    body: z.object({ filter: filterSchema, view: z.enum(['active', 'archived', 'all']).default('active'), reason: z.string().trim().min(5).max(300) }),
  },
  async ({ ctx, body }) => {
    const { csv } = await exportLeadsCsv(ctx, body.filter, body.view, body.reason);
    return new Response(csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="leads-export-${new Date().toISOString().slice(0, 10)}.csv"`,
        'cache-control': 'no-store',
      },
    });
  },
);
