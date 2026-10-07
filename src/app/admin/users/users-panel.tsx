'use client';
import type { ColumnDef } from '@tanstack/react-table';
import { Copy, Search, UserPlus, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { DataTable } from '@/components/data/data-table';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/input';
import { Dialog } from '@/components/ui/overlay';
import { InlineNotice } from '@/components/ui/states';
import { api, errorMessage } from '@/lib/api-client';
import { fmtAgo, fmtDate } from '@/lib/format';
import { useApiMutation, useApiQuery } from '@/lib/hooks';

type U = { id: string; email: string; name: string; status: string; mfaEnabled: boolean; lastLoginAt: string | null; lockedUntil: string | null; createdAt: string; membership: { organizationId: string | null; organization: { name: string; code: string } | null; role: { id: string; name: string } } | null; _count: { sessions: number } };
type Inv = { id: string; email: string; name: string; role: string; expiresAt: string };
type Role = { id: string; name: string; scope: string; organizationId: string | null; isPrivileged: boolean; rank: number };

export function UsersPanel({ organizationId, platformOnly, canInvite, showOrg }: { organizationId?: string; platformOnly?: boolean; canInvite: boolean; showOrg?: boolean }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [invite, setInvite] = useState(false);
  const scopeQ = organizationId ? `&organizationId=${organizationId}` : platformOnly ? '&platformOnly=1' : '';
  const { data, isFetching, error } = useApiQuery<{ total: number; rows: U[]; invitations: Inv[] }>(`/api/v1/users?page=${page}&pageSize=25${scopeQ}${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  const revoke = useApiMutation((id: string) => api(`/api/v1/users/invitations/${id}`, { method: 'DELETE' }), { success: 'Invitation revoked', invalidate: ['/api/v1/users'] });
  const columns: ColumnDef<U, unknown>[] = [
    { id: 'name', header: 'User', cell: ({ row: { original: u } }) => <div><div className="text-fg">{u.name}</div><div className="text-[11px] text-subtle">{u.email}</div></div> },
    ...(showOrg ? [{ id: 'org', header: 'Workspace', cell: ({ row: { original: u } }: { row: { original: U } }) => <span className="text-muted">{u.membership?.organization?.name ?? 'Platform'}</span> }] : []),
    { id: 'role', header: 'Role', cell: ({ row: { original: u } }) => u.membership?.role.name ?? '—' },
    { id: 'status', header: 'Status', cell: ({ row: { original: u } }) => <span className="flex gap-1.5"><StatusBadge status={u.status} />{u.lockedUntil && new Date(u.lockedUntil) > new Date() && <Badge tone="danger">Locked</Badge>}</span> },
    { id: 'mfa', header: 'MFA', cell: ({ row: { original: u } }) => (u.mfaEnabled ? <Badge tone="ok">On</Badge> : <Badge tone="dim">Off</Badge>) },
    { id: 'sessions', header: 'Sessions', cell: ({ row: { original: u } }) => <span className="tnum">{u._count.sessions}</span> },
    { id: 'login', header: 'Last sign-in', cell: ({ row: { original: u } }) => <span className="text-subtle">{u.lastLoginAt ? fmtAgo(u.lastLoginAt) : 'Never'}</span> },
  ];
  return (
    <div className="flex flex-col gap-4">
      <DataTable
        columns={columns} data={data?.rows ?? []} total={data?.total ?? 0} page={page} pageSize={25} onPage={setPage} loading={isFetching} error={error ? errorMessage(error) : null}
        getRowId={(r) => r.id} onRowClick={(r) => router.push(`/admin/users/${r.id}`)}
        toolbar={
          <>
            <div className="relative w-64"><Search className="absolute top-2 left-2.5 size-3.5 text-subtle" /><Input className="pl-8" placeholder="Search name or email" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} /></div>
            {canInvite && <Button size="sm" variant="primary" className="ml-auto" onClick={() => setInvite(true)}><UserPlus /> Invite user</Button>}
          </>
        }
      />
      {data?.invitations && data.invitations.length > 0 && (
        <Card>
          <CardHeader title="Pending invitations" />
          <ul>
            {data.invitations.map((i) => (
              <li key={i.id} className="flex items-center gap-3 border-b border-border/60 px-4 py-2 text-[12.5px] last:border-0">
                <span className="min-w-0 flex-1 truncate">{i.name} <span className="text-subtle">· {i.email}</span></span>
                <Badge tone="outline">{i.role}</Badge>
                <span className="text-[11px] text-subtle">expires {fmtDate(i.expiresAt)}</span>
                {canInvite && <Button size="xs" variant="ghost" onClick={() => revoke.mutate(i.id)}><X /> Revoke</Button>}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {invite && <InviteDialog organizationId={organizationId ?? null} platform={!organizationId} onClose={() => setInvite(false)} />}
    </div>
  );
}

export function InviteDialog({ organizationId, platform, onClose, endpoint = '/api/v1/users/invitations', rolesUrl }: { organizationId: string | null; platform: boolean; onClose: () => void; endpoint?: string; rolesUrl?: string }) {
  const roles = useApiQuery<{ roles: Role[] }>(rolesUrl ?? `/api/v1/roles?scope=${platform ? 'PLATFORM' : 'ORGANIZATION'}${organizationId ? `&organizationId=${organizationId}` : ''}`);
  const [f, setF] = useState({ name: '', email: '', roleId: '' });
  const [result, setResult] = useState<{ inviteUrl: string; pendingApproval: string | null } | null>(null);
  const send = useApiMutation((b: object) => api<{ inviteUrl: string; pendingApproval: string | null }>(endpoint, { body: b }), { invalidate: ['/api/v1/users', '/api/v1/crm/team'], onSuccess: setResult });
  const options = (roles.data?.roles ?? []).filter((r) => r.scope === (platform ? 'PLATFORM' : 'ORGANIZATION'));
  if (result) {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()} title={result.pendingApproval ? 'Approval requested' : 'Invitation sent'} size="md" footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        {result.pendingApproval ? (
          <InlineNotice>This role is highly privileged. A different administrator must approve the invitation under Approvals before it is sent.</InlineNotice>
        ) : (
          <div className="flex flex-col gap-3 text-[12.5px]">
            <InlineNotice>If email delivery isn’t configured, share this single-use link securely. It expires in 7 days.</InlineNotice>
            <div className="flex items-center gap-2"><code className="min-w-0 flex-1 truncate rounded border border-border-strong bg-surface-2 px-2 py-1.5 font-mono text-[11px]">{result.inviteUrl}</code><Button size="sm" onClick={() => { navigator.clipboard.writeText(result.inviteUrl); toast.success('Copied'); }}><Copy /> Copy</Button></div>
          </div>
        )}
      </Dialog>
    );
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Invite user" description="The user sets their own password via a secure link. Passwords are never set or seen by administrators." size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={send.isPending} disabled={!f.email || !f.name || !f.roleId} onClick={() => send.mutate({ ...f, ...(platform ? {} : { organizationId }) })}>Send invitation</Button></>}>
      <div className="flex flex-col gap-3">
        <Field label="Full name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></Field>
        <Field label="Email"><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Role" hint="You can only grant roles at or below your own privilege level.">
          <Select value={f.roleId} onChange={(e) => setF({ ...f, roleId: e.target.value })}>
            <option value="">Select a role…</option>
            {options.map((r) => <option key={r.id} value={r.id}>{r.name}{r.isPrivileged ? ' (requires approval)' : ''}{r.organizationId ? ' · custom' : ''}</option>)}
          </Select>
        </Field>
      </div>
    </Dialog>
  );
}
