import { route } from '@/server/api';
import { toCsv } from '@/server/services/normalize';

/** A blank template file showing the expected columns. Contains no data. */
export const GET = route({ perm: 'imports.create' }, async () =>
  new Response(toCsv([['Full Name', 'Email', 'Phone', 'Company', 'Job Title', 'City', 'State', 'Country', 'Industry', 'Source', 'Campaign', 'Score', 'Priority', 'Tags']]), {
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="lead-import-template.csv"' },
  }),
);
