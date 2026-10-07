'use client';
import { ArrowRightLeft, Pencil, Plus, Target, Trash2, UserPlus, UserX, X } from 'lucide-react';
import { useState } from 'react';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Checkbox, Dialog, Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/overlay';
import { PageHeader } from '@/components/ui/page';
import { Skeleton } from '@/components/ui/states';
import { api } from '@/lib/api-client';
import { fmtAgo, fmtDate, fmtInt } from '@/lib/format';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { InviteDialog } from '../../admin/users/users-panel';

type Member = { id: string; name: string; email: string; status: string; lastLoginAt: string | null; mfaEnabled: boolean; title: string | null; role: { id: string; name: string; key: string; rank: number }; leads: number; open: number; convertedMtd: number; contactsMtd: number; overdueTasks: number; targets: Record<string, number> };
type TeamT = { id: string; name: string; description: string | null; managerId: string | null; memberIds: string[] };
type Data = { members: Member[]; teams: TeamT[]; invitations: { id: string; email: string; name: string; role: string; expiresAt: string }[] };

function Progress({ value, target }: { value: number; target?: number }) {
  if (!target) return <span className="tnum">{fmtInt(value)}</span>;
  const pct = Math.min(1, value / target);
  return (
    <div className="flex items-center gap-2"><span className="tnum">{value}<span className="text-subtle">/{target}</span></span>
      <div className="h-1 w-12 overflow-hidden rounded-full bg-surface-3"><div className="h-full bg-fg/80" style={{ width: `${pct * 100}%` }} /></div></div>
  );
}

export function TeamView({ selfId, orgId, perms }: { selfId: string; orgId: string; perms: { manage: boolean; users: boolean } }) {
  const { data } = useApiQuery<Data>('/api/v1/crm/team');
  const roles = useApiQuery<{ roles: { id: string; name: string }[] }>(perms.users ? '/api/v1/crm/roles' : null);
  const [invite, setInvite] = useState(false);
  const [team, setTeam] = useState<TeamT | 'new' | null>(null);
  const [target, setTarget] = useState<Member | null>(null);
  const [transfer, setTransfer] = useState<Member | null>(null);
  const [deactivate, setDeactivate] = useState<Member | null>(null);
  const [roleFor, setRoleFor] = useState<Member | null>(null);
  const [roleId, setRoleId] = useState('');
  const [toUser, setToUser] = useState('');
  const inv = ['/api/v1/crm/team'];
  const revokeInv = useApiMutation((id: string) => api(`/api/v1/crm/users/invitations/${id}`, { method: 'DELETE' }), { success: 'Invitation revoked', invalidate: inv });
  const status = useApiMutation((b: { id: string; status: string; reason: string }) => api(`/api/v1/crm/users/${b.id}/status`, { body: { status: b.status, reason: b.reason } }), { success: 'Member updated', invalidate: inv });
  const role = useApiMutation((b: { id: string; reason: string }) => api(`/api/v1/crm/users/${b.id}/role`, { body: { roleId, reason: b.reason } }), { success: 'Role updated', invalidate: inv });
  const xfer = useApiMutation((b: { from: string }) => api<{ leads: number; tasks: number }>('/api/v1/crm/team/transfer', { body: { fromUserId: b.from, toUserId: toUser } }), { success: (r) => `Transferred ${r.leads} leads and ${r.tasks} tasks`, invalidate: ['/api/v1/crm'] });
  const delTeam = useApiMutation((id: string) => api(`/api/v1/crm/team/teams/${id}`, { method: 'DELETE' }), { success: 'Team deleted', invalidate: inv });

  if (!data) return <Skeleton className="h-96" />;
  const active = data.members.filter((m) => m.status === 'ACTIVE');
  const name = (id: string | null) => data.members.find((m) => m.id === id)?.name ?? '—';

  return (
    <>
      <PageHeader title="Team" description="Members, roles, targets and workload." actions={perms.users && <Button variant="primary" onClick={() => setInvite(true)}><UserPlus /> Invite member</Button>} />
      <Card className="mb-4 overflow-x-auto">
        <table className="w-full min-w-[860px] text-[12.5px]">
          <thead><tr className="border-b border-border text-left text-[10.5px] uppercase tracking-[0.08em] text-subtle">
            <th className="h-8 px-4">Member</th><th>Role</th><th>Status</th><th className="text-right">Open leads</th><th>Contacts (MTD)</th><th>Conversions (MTD)</th><th className="text-right">Overdue tasks</th><th>Last sign-in</th><th className="w-10" />
          </tr></thead>
          <tbody>
            {data.members.map((m) => (
              <tr key={m.id} className="border-b border-border/60 last:border-0">
                <td className="px-4 py-2"><div className="text-fg">{m.name}{m.id === selfId && <span className="text-subtle"> (you)</span>}</div><div className="text-[11px] text-subtle">{m.email}</div></td>
                <td>{m.role.name}</td>
                <td><span className="flex gap-1"><StatusBadge status={m.status} />{!m.mfaEnabled && m.status === 'ACTIVE' && <Badge tone="dim">no MFA</Badge>}</span></td>
                <td className="tnum text-right">{fmtInt(m.open)}</td>
                <td><Progress value={m.contactsMtd} target={m.targets.CONTACTS} /></td>
                <td><Progress value={m.convertedMtd} target={m.targets.CONVERSIONS} /></td>
                <td className={`tnum text-right ${m.overdueTasks ? 'text-warn' : ''}`}>{m.overdueTasks}</td>
                <td className="text-subtle">{m.lastLoginAt ? fmtAgo(m.lastLoginAt) : 'Never'}</td>
                <td className="pr-2">
                  {(perms.manage || perms.users) && m.id !== selfId && (
                    <Menu>
                      <MenuTrigger asChild><Button size="icon" variant="ghost" aria-label={`Actions for ${m.name}`}>⋯</Button></MenuTrigger>
                      <MenuContent>
                        {perms.manage && <MenuItem onSelect={() => setTarget(m)}><Target /> Set monthly targets</MenuItem>}
                        {perms.manage && <MenuItem onSelect={() => { setToUser(''); setTransfer(m); }}><ArrowRightLeft /> Transfer ownership</MenuItem>}
                        {perms.users && <MenuItem onSelect={() => { setRoleId(m.role.id); setRoleFor(m); }}><Pencil /> Change role</MenuItem>}
                        {perms.users && m.status === 'ACTIVE' && <MenuItem danger onSelect={() => setDeactivate(m)}><UserX /> Deactivate</MenuItem>}
                        {perms.users && m.status === 'DEACTIVATED' && <MenuItem onSelect={() => status.mutate({ id: m.id, status: 'ACTIVE', reason: 'Reactivated by workspace admin' })}>Reactivate</MenuItem>}
                      </MenuContent>
                    </Menu>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Teams" actions={perms.manage && <Button size="sm" onClick={() => setTeam('new')}><Plus /> New team</Button>} />
          <ul>
            {data.teams.length === 0 && <li className="px-4 py-5 text-xs text-subtle">No teams yet</li>}
            {data.teams.map((t) => (
              <li key={t.id} className="flex items-center gap-3 border-b border-border/60 px-4 py-2.5 last:border-0">
                <div className="min-w-0 flex-1"><div className="text-[12.5px]">{t.name}</div><div className="truncate text-[11px] text-subtle">Manager: {name(t.managerId)} · {t.memberIds.length} member(s){t.description ? ` · ${t.description}` : ''}</div></div>
                {perms.manage && <><Button size="xs" variant="ghost" onClick={() => setTeam(t)}><Pencil /></Button><Button size="xs" variant="ghost" onClick={() => delTeam.mutate(t.id)}><Trash2 /></Button></>}
              </li>
            ))}
          </ul>
        </Card>
        {data.invitations.length > 0 && (
          <Card>
            <CardHeader title="Pending invitations" />
            <ul>{data.invitations.map((i) => (
              <li key={i.id} className="flex items-center gap-3 border-b border-border/60 px-4 py-2 text-[12.5px] last:border-0">
                <span className="min-w-0 flex-1 truncate">{i.name} <span className="text-subtle">· {i.email}</span></span><Badge tone="outline">{i.role}</Badge><span className="text-[11px] text-subtle">expires {fmtDate(i.expiresAt)}</span>
                {perms.users && <Button size="xs" variant="ghost" onClick={() => revokeInv.mutate(i.id)}><X /></Button>}
              </li>
            ))}</ul>
          </Card>
        )}
      </div>
      {invite && <InviteDialog organizationId={orgId} platform={false} endpoint="/api/v1/crm/users/invite" rolesUrl="/api/v1/crm/roles" onClose={() => setInvite(false)} />}
      {team && <TeamForm team={team === 'new' ? null : team} members={active} onClose={() => setTeam(null)} />}
      {target && <TargetForm member={target} onClose={() => setTarget(null)} />}
      <ConfirmDialog open={!!transfer} onOpenChange={(o) => !o && setTransfer(null)} title={`Transfer ${transfer?.name}’s work`} confirmLabel="Transfer" description="All open leads and open tasks owned by this member move to the recipient." onConfirm={() => xfer.mutateAsync({ from: transfer!.id })}>
        <Field label="Recipient"><Select value={toUser} onChange={(e) => setToUser(e.target.value)}><option value="">Select…</option>{active.filter((m) => m.id !== transfer?.id).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></Field>
      </ConfirmDialog>
      <ConfirmDialog open={!!deactivate} onOpenChange={(o) => !o && setDeactivate(null)} title={`Deactivate ${deactivate?.name}`} danger requireReason confirmLabel="Deactivate" description="They are signed out immediately. Transfer their open leads first so nothing is left unowned." onConfirm={(reason) => status.mutateAsync({ id: deactivate!.id, status: 'DEACTIVATED', reason })} />
      <ConfirmDialog open={!!roleFor} onOpenChange={(o) => !o && setRoleFor(null)} title={`Change role for ${roleFor?.name}`} requireReason confirmLabel="Change role" onConfirm={(reason) => role.mutateAsync({ id: roleFor!.id, reason })}>
        <Field label="Role" hint="You can only assign roles at or below your own level."><Select value={roleId} onChange={(e) => setRoleId(e.target.value)}>{roles.data?.roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select></Field>
      </ConfirmDialog>
    </>
  );
}

function TeamForm({ team, members, onClose }: { team: TeamT | null; members: Member[]; onClose: () => void }) {
  const [f, setF] = useState({ name: team?.name ?? '', description: team?.description ?? '', managerId: team?.managerId ?? '', memberIds: team?.memberIds ?? [] });
  const save = useApiMutation(() => api(team ? `/api/v1/crm/team/teams/${team.id}` : '/api/v1/crm/team/teams', { method: team ? 'PUT' : 'POST', body: { ...f, managerId: f.managerId || null, description: f.description || null } }), { success: 'Team saved', invalidate: ['/api/v1/crm/team'], onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={team ? 'Edit team' : 'New team'} size="md" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={f.name.trim().length < 2} onClick={() => save.mutate(undefined)}>Save</Button></>}>
      <div className="flex flex-col gap-3">
        <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Description"><Textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <Field label="Manager"><Select value={f.managerId} onChange={(e) => setF({ ...f, managerId: e.target.value })}><option value="">None</option>{members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></Field>
        <Field label="Members"><div className="flex max-h-48 flex-col gap-1.5 overflow-y-auto rounded-md border border-border-strong p-2">{members.map((m) => <label key={m.id} className="flex items-center gap-2 text-[12.5px]"><Checkbox checked={f.memberIds.includes(m.id)} onCheckedChange={(c) => setF({ ...f, memberIds: c ? [...f.memberIds, m.id] : f.memberIds.filter((x) => x !== m.id) })} aria-label={m.name} />{m.name}<span className="text-subtle">· {m.role.name}</span></label>)}</div></Field>
      </div>
    </Dialog>
  );
}

function TargetForm({ member, onClose }: { member: Member; onClose: () => void }) {
  const [c, setC] = useState(String(member.targets.CONTACTS ?? ''));
  const [v, setV] = useState(String(member.targets.CONVERSIONS ?? ''));
  const save = useApiMutation(async () => {
    if (c !== '') await api('/api/v1/crm/team/targets', { body: { userId: member.id, metric: 'CONTACTS', target: Number(c) } });
    if (v !== '') await api('/api/v1/crm/team/targets', { body: { userId: member.id, metric: 'CONVERSIONS', target: Number(v) } });
  }, { success: 'Targets saved', invalidate: ['/api/v1/crm/team'], onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Targets for ${member.name}`} description="For the current calendar month" size="sm" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>Save</Button></>}>
      <div className="grid grid-cols-2 gap-3"><Field label="Contact attempts"><Input type="number" min={0} value={c} onChange={(e) => setC(e.target.value)} /></Field><Field label="Conversions"><Input type="number" min={0} value={v} onChange={(e) => setV(e.target.value)} /></Field></div>
    </Dialog>
  );
}
