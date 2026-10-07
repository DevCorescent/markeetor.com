import { requirePage } from '@/server/page';
import { orgSettings } from '@/server/services/organizations';
import { LeadProfile } from './lead-profile';

export const metadata = { title: 'Lead' };

export default async function LeadPage(props: PageProps<'/app/leads/[id]'>) {
  const ctx = await requirePage({ scope: 'ORGANIZATION', perm: ['crm.leads.read_all', 'crm.leads.read_own'] });
  const { id } = await props.params;
  const s = orgSettings(ctx.org?.settings);
  const p = (k: string) => ctx.permissions.has(k);
  return (
    <LeadProfile
      id={id}
      selfId={ctx.user.id}
      features={s.features}
      revealRequiresReason={s.security.revealRequiresReason}
      perms={{
        update: p('crm.leads.update'), reveal: p('crm.leads.reveal'), assign: p('crm.leads.assign'), notes: p('crm.notes.write'), comms: p('crm.comms.log'),
        tasks: p('crm.tasks.manage'), upload: p('crm.attachments.upload'), view: p('crm.attachments.view'), move: p('crm.pipeline.move'), archive: p('crm.leads.archive'), merge: p('crm.leads.merge'), email: p('crm.email.send') && s.features.email, marketing: p('crm.email.send') || p('crm.email.manage'),
      }}
    />
  );
}
