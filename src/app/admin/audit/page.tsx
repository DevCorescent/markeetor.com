import { PageHeader } from '@/components/ui/page';
import { requirePage } from '@/server/page';
import { AuditLog } from './audit-log';

export const metadata = { title: 'Audit log' };

export default async function AuditPage() {
  const ctx = await requirePage({ scope: 'PLATFORM', perm: 'audit.read' });
  return (
    <>
      <PageHeader title="Audit log" description="Append-only, hash-chained record of administrative and CRM events. Rows cannot be edited; deletion only occurs through the configured retention policy." />
      <AuditLog canExport={ctx.permissions.has('audit.export')} canVerify={ctx.permissions.has('audit.admin')} />
    </>
  );
}
