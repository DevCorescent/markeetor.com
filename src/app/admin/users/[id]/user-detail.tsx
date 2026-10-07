'use client';
import { KeyRound, LockOpen, LogOut, Mail, ShieldOff, Trash2, UserCheck, UserX } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, DefinitionList } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Field, Input, Select } from '@/components/ui/input';
import { Dialog } from '@/components/ui/overlay';
import { PageHeader } from '@/components/ui/page';
import { ErrorState, Skeleton } from '@/components/ui/states';
import { SimpleTable } from '@/components/ui/simple-table';
import { api, errorMessage } from '@/lib/api-client';
import { ALL_PERMISSIONS } from '@/lib/permissions';
import { fmtAgo, fmtDateTime } from '@/lib/format';
import { useApiMutation, useApiQuery } from '@/lib/hooks';

type Detail = {
  user: { id: string; email: string; name: string; status: string; mfaEnabled: boolean; lockedUntil: string | null; lastLoginAt: string | null; lastLoginIp: string | null; createdAt: string; title: string | null };
  role: { id: string; name: string; key: string; scope: string; isPrivileged: boolean };
  organization: { id: string; name: string; code: string } | null;
  sessions: { id: string; ip: string | null; userAgent: string | null; createdAt: string; lastSeenAt: string }[];
  logins: { id: string; success: boolean; reason: string | null; ip: string | null; createdAt: string }[];
  overrides: { id: string; permissionKey: string; effect: string; reason: string; expiresAt: string | null }[];
  activity: { id: string; action: string; targetType: string | null; result: string; createdAt: string; ip: string | null }[];
};

export function UserDetail({ id, selfId, perms }: { id: string; selfId: string; perms: { manage: boolean; sessions: boolean; roles: boolean } }) {
  const { data, error, isLoading } = useApiQuery<Detail>(`/api/v1/users/${id}`);
  const roles = useApiQuery<{ roles: { id: string; name: string; scope: string; organizationId: string | null; isPrivileged: boolean }[] }>(perms.roles && data ? `/api/v1/roles?scope=${data.role.scope}${data.organization ? `&organizationId=${data.organization.id}` : ''}` : null);
  const [dlg, setDlg] = useState<null | 'suspend' | 'deactivate' | 'activate' | 'unlock' | 'reset_mfa' | 'send_password_reset' | 'revoke_sessions' | 'role' | 'override'>(null);
  const [roleId, setRoleId] = useState('');
  const [ov, setOv] = useState({ permissionKey: '', effect: 'GRANT', reason: '', expiresAt: '' });
  const inv = ['/api/v1/users'];
  const status = useApiMutation((b: { status: string; reason: string }) => api(`/api/v1/users/${id}/status`, { body: b }), { success: 'Status updated', invalidate: inv });
  const action = useApiMutation((b: { action: string; reason: string }) => api(`/api/v1/users/${id}/actions`, { body: b }), { success: 'Done', invalidate: inv });
  const role = useApiMutation((b: { roleId: string; reason: string }) => api<{ changed: boolean; pendingApproval: string | null }>(`/api/v1/users/${id}/role`, { body: b }), { success: (r) => (r.pendingApproval ? 'Sent for approval' : 'Role changed'), invalidate: inv });
  const override = useApiMutation((b: object) => api(`/api/v1/users/${id}/overrides`, { method: 'PUT', body: b }), { success: 'Override saved', invalidate: inv, onSuccess: () => setDlg(null) });
  const removeOverride = useApiMutation((k: string) => api(`/api/v1/users/${id}/overrides`, { method: 'DELETE', body: { permissionKey: k } }), { success: 'Override removed', invalidate: inv });

  if (error) return <ErrorState description={errorMessage(error)} />;
  if (isLoading || !data) return <Skeleton className="h-96" />;
  const u = data.user;
  const self = u.id === selfId;
  const locked = u.lockedUntil && new Date(u.lockedUntil) > new Date();
  const scopePerms = Object.entries(ALL_PERMISSIONS).filter(([, d]) => d.scope === data.role.scope);

  return (
    <>
      <PageHeader crumbs={[{ label: 'Users', href: '/admin/users' }, { label: u.name }]} title={<span className="flex items-center gap-3">{u.name}<StatusBadge status={u.status} />{locked && <Badge tone="danger">Locked</Badge>}</span>} description={u.email}
        actions={!self && (
          <>
            {perms.manage && u.status === 'ACTIVE' && <Button variant="ghost" onClick={() => setDlg('suspend')}><UserX /> Suspend</Button>}
            {perms.manage && (u.status === 'SUSPENDED' || u.status === 'DEACTIVATED') && <Button variant="ghost" onClick={() => setDlg('activate')}><UserCheck /> Reactivate</Button>}
            {perms.roles && <Button onClick={() => { setRoleId(data.role.id); setDlg('role'); }}><KeyRound /> Change role</Button>}
          </>
        )} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_360px]">
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title="Account" />
            <CardBody>
              <DefinitionList items={[
                ['Role', <span key="r">{data.role.name}{data.role.isPrivileged && <Badge tone="warn" className="ml-2">Privileged</Badge>}</span>],
                ['Workspace', data.organization ? <Link key="o" className="underline" href={`/admin/organizations/${data.organization.id}`}>{data.organization.name}</Link> : 'Platform'],
                ['Two-factor', u.mfaEnabled ? 'Enabled' : 'Not enabled'], ['Created', fmtDateTime(u.createdAt)],
                ['Last sign-in', u.lastLoginAt ? `${fmtDateTime(u.lastLoginAt)} from ${u.lastLoginIp ?? '—'}` : 'Never'], ['Locked until', locked ? fmtDateTime(u.lockedUntil) : '—'],
              ]} />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Permission overrides" description="Per-user exceptions to the role. Grants are limited to permissions you hold." actions={perms.roles && !self && <Button size="sm" onClick={() => setDlg('override')}>Add override</Button>} />
            <SimpleTable rows={data.overrides} empty={<div className="py-5 text-center text-xs text-subtle">No overrides — permissions come from the role only</div>} columns={[
              { key: 'permissionKey', header: 'Permission', render: (r) => <span className="font-mono text-[11.5px]">{r.permissionKey}</span> },
              { key: 'effect', header: 'Effect', render: (r) => <Badge tone={r.effect === 'GRANT' ? 'warn' : 'neutral'}>{r.effect}</Badge> },
              { key: 'reason', header: 'Reason', render: (r) => <span className="text-muted">{r.reason}</span> },
              { key: 'expiresAt', header: 'Expires', render: (r) => fmtDateTime(r.expiresAt) },
              { key: 'x', header: '', render: (r) => perms.roles && <Button size="xs" variant="ghost" onClick={() => removeOverride.mutate(r.permissionKey)}><Trash2 /></Button> },
            ]} />
          </Card>
          <Card>
            <CardHeader title="Recent activity" />
            <SimpleTable rows={data.activity} columns={[
              { key: 'action', header: 'Action', render: (r) => <span className="font-mono text-[11.5px]">{r.action}</span> },
              { key: 'result', header: 'Result', render: (r) => <StatusBadge status={r.result} /> },
              { key: 'ip', header: 'IP', render: (r) => <span className="font-mono text-[11px] text-subtle">{r.ip ?? '—'}</span> },
              { key: 'createdAt', header: 'When', render: (r) => <span className="text-subtle">{fmtAgo(r.createdAt)}</span> },
            ]} />
          </Card>
        </div>
        <div className="flex flex-col gap-4">
          {!self && (perms.manage || perms.sessions) && (
            <Card>
              <CardHeader title="Security actions" />
              <CardBody className="flex flex-col gap-1.5">
                {perms.sessions && <Button variant="ghost" className="justify-start" onClick={() => setDlg('revoke_sessions')}><LogOut /> Revoke all sessions</Button>}
                {perms.manage && locked && <Button variant="ghost" className="justify-start" onClick={() => setDlg('unlock')}><LockOpen /> Unlock account</Button>}
                {perms.manage && <Button variant="ghost" className="justify-start" onClick={() => setDlg('send_password_reset')}><Mail /> Send password reset</Button>}
                {perms.manage && u.mfaEnabled && <Button variant="ghost" className="justify-start" onClick={() => setDlg('reset_mfa')}><ShieldOff /> Reset two-factor</Button>}
                {perms.manage && u.status !== 'DEACTIVATED' && <Button variant="ghost" className="justify-start text-danger" onClick={() => setDlg('deactivate')}><UserX /> Deactivate</Button>}
              </CardBody>
            </Card>
          )}
          <Card>
            <CardHeader title={`Active sessions (${data.sessions.length})`} />
            <ul>{data.sessions.length === 0 && <li className="px-4 py-4 text-xs text-subtle">None</li>}{data.sessions.map((s) => (
              <li key={s.id} className="border-b border-border/60 px-4 py-2 text-[12px] last:border-0"><div className="truncate">{s.userAgent?.replace(/\(.*?\)/g, '').slice(0, 60) ?? 'Unknown'}</div><div className="text-[11px] text-subtle">{s.ip ?? '—'} · active {fmtAgo(s.lastSeenAt)}</div></li>
            ))}</ul>
          </Card>
          <Card>
            <CardHeader title="Login history" />
            <ul>{data.logins.map((l) => (
              <li key={l.id} className="flex items-center gap-2 border-b border-border/60 px-4 py-1.5 text-[12px] last:border-0">
                <span className={`size-1.5 rounded-full ${l.success ? 'bg-ok' : 'bg-danger'}`} aria-label={l.success ? 'success' : 'failure'} />
                <span className="flex-1 truncate text-muted">{l.reason?.replace(/_/g, ' ')}</span><span className="font-mono text-[10.5px] text-subtle">{l.ip}</span><span className="text-[10.5px] text-subtle">{fmtAgo(l.createdAt)}</span>
              </li>
            ))}</ul>
          </Card>
        </div>
      </div>

      {(['suspend', 'deactivate', 'activate'] as const).map((k) => (
        <ConfirmDialog key={k} open={dlg === k} onOpenChange={(o) => !o && setDlg(null)} title={`${k[0].toUpperCase()}${k.slice(1)} ${u.name}`} requireReason danger={k !== 'activate'} confirmLabel={k[0].toUpperCase() + k.slice(1)}
          description={k === 'activate' ? 'The user will be able to sign in again.' : 'All active sessions are revoked immediately.'}
          onConfirm={(reason) => status.mutateAsync({ status: k === 'suspend' ? 'SUSPENDED' : k === 'deactivate' ? 'DEACTIVATED' : 'ACTIVE', reason })} />
      ))}
      {(['unlock', 'reset_mfa', 'send_password_reset', 'revoke_sessions'] as const).map((k) => (
        <ConfirmDialog key={k} open={dlg === k} onOpenChange={(o) => !o && setDlg(null)} title={{ unlock: 'Unlock account', reset_mfa: 'Reset two-factor authentication', send_password_reset: 'Send password reset email', revoke_sessions: 'Revoke all sessions' }[k]}
          requireReason danger={k === 'reset_mfa'} confirmLabel="Confirm" onConfirm={(reason) => action.mutateAsync({ action: k, reason })} />
      ))}
      <ConfirmDialog open={dlg === 'role'} onOpenChange={(o) => !o && setDlg(null)} title="Change role" requireReason confirmLabel="Change role" description="Takes effect on the user’s next request. Privileged roles require approval by another administrator."
        onConfirm={(reason) => role.mutateAsync({ roleId, reason })}>
        <Field label="Role"><Select value={roleId} onChange={(e) => setRoleId(e.target.value)}>{roles.data?.roles.filter((r) => r.scope === data.role.scope && (!r.organizationId || r.organizationId === data.organization?.id)).map((r) => <option key={r.id} value={r.id}>{r.name}{r.isPrivileged ? ' (approval)' : ''}</option>)}</Select></Field>
      </ConfirmDialog>
      <Dialog open={dlg === 'override'} onOpenChange={(o) => !o && setDlg(null)} title="Add permission override" size="sm"
        footer={<><Button variant="ghost" onClick={() => setDlg(null)}>Cancel</Button><Button variant="primary" loading={override.isPending} disabled={!ov.permissionKey || ov.reason.trim().length < 3} onClick={() => override.mutate({ ...ov, expiresAt: ov.expiresAt ? new Date(ov.expiresAt).toISOString() : null })}>Save</Button></>}>
        <div className="flex flex-col gap-3">
          <Field label="Permission"><Select value={ov.permissionKey} onChange={(e) => setOv({ ...ov, permissionKey: e.target.value })}><option value="">Select…</option>{scopePerms.map(([k, d]) => <option key={k} value={k}>{k} — {d.description}</option>)}</Select></Field>
          <Field label="Effect"><Select value={ov.effect} onChange={(e) => setOv({ ...ov, effect: e.target.value })}><option value="GRANT">Grant</option><option value="DENY">Deny</option></Select></Field>
          <Field label="Expires (optional)"><Input type="datetime-local" value={ov.expiresAt} onChange={(e) => setOv({ ...ov, expiresAt: e.target.value })} /></Field>
          <Field label="Reason"><Input value={ov.reason} onChange={(e) => setOv({ ...ov, reason: e.target.value })} /></Field>
        </div>
      </Dialog>
    </>
  );
}
