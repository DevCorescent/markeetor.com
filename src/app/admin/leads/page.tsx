import { requirePage } from '@/server/page';
import { LeadRepository } from './lead-repository';

export const metadata = { title: 'Lead repository' };

export default async function LeadsPage() {
  const ctx = await requirePage({ scope: 'PLATFORM', perm: 'leads.read' });
  const p = (k: string) => ctx.permissions.has(k);
  return <LeadRepository perms={{ update: p('leads.update'), archive: p('leads.archive'), merge: p('leads.merge'), export: p('leads.export'), distribute: p('distribution.create'), reassign: p('distribution.reassign'), email: p('email.send'), enrich: p('leads.enrich') }} />;
}
