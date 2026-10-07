import { requirePage } from '@/server/page';
import { orgSettings } from '@/server/services/organizations';
import { ClientLeads } from './client-leads';

export const metadata = { title: 'Leads' };

export default async function Leads() {
  const ctx = await requirePage({ scope: 'ORGANIZATION', perm: ['crm.leads.read_all', 'crm.leads.read_own'] });
  const p = (k: string) => ctx.permissions.has(k);
  return <ClientLeads perms={{ all: p('crm.leads.read_all'), assign: p('crm.leads.assign'), bulk: p('crm.leads.bulk'), update: p('crm.leads.update'), archive: p('crm.leads.archive'), email: p('crm.email.send') && orgSettings(ctx.org?.settings).features.email, marketplace: p('crm.marketplace.view') && orgSettings(ctx.org?.settings).features.marketplace !== false }} />;
}
