import { requirePage } from '@/server/page';
import { LeadDetail } from './lead-detail';

export const metadata = { title: 'Lead' };

export default async function LeadPage(props: PageProps<'/admin/leads/[id]'>) {
  const ctx = await requirePage({ scope: 'PLATFORM', perm: 'leads.read' });
  const { id } = await props.params;
  const p = (k: string) => ctx.permissions.has(k);
  return <LeadDetail id={id} perms={{ reveal: p('leads.reveal'), update: p('leads.update'), merge: p('leads.merge'), archive: p('leads.archive'), reassign: p('distribution.reassign'), email: p('email.send'), enrich: p('leads.enrich') }} />;
}
