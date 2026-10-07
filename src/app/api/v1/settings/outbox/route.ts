import { paginationQuery, route } from '@/server/api';
import { outbox } from '@/server/services/governance';

/**
 * Development outbox. Message bodies contain single-use links (invitations, password resets), so they are
 * only returned outside production; in production only delivery metadata is shown.
 */
export const GET = route({ perm: 'system.manage', query: paginationQuery }, async ({ query }) => {
  const res = await outbox(query.page, query.pageSize);
  const showBodies = process.env.NODE_ENV !== 'production';
  return { ...res, showBodies, rows: res.rows.map((r) => ({ ...r, body: showBodies ? r.body : undefined })) };
});
