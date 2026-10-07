'use client';
import { Check, Lock, Plus } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input, Textarea } from '@/components/ui/input';
import { Checkbox, Drawer } from '@/components/ui/overlay';
import { Skeleton } from '@/components/ui/states';
import { api } from '@/lib/api-client';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { cn } from '@/lib/cn';

type Role = { id: string; key: string; name: string; description: string | null; scope: string; organizationId: string | null; isSystem: boolean; isPrivileged: boolean; rank: number; permissions: string[]; members?: number };
type PermDef = { description: string; group: string; sensitive?: boolean; scope?: string };

/** Permission matrix + custom role editor, shared by platform and workspace settings. */
export function RolesEditor({ endpoint, canManage, scope }: { endpoint: string; canManage: boolean; scope?: 'PLATFORM' | 'ORGANIZATION' }) {
  const { data, isLoading } = useApiQuery<{ roles: Role[]; permissions: Record<string, PermDef> }>(endpoint);
  const [tab, setTab] = useState<'PLATFORM' | 'ORGANIZATION'>(scope ?? 'PLATFORM');
  const [editing, setEditing] = useState<Role | 'new' | null>(null);
  if (isLoading || !data) return <Skeleton className="h-96" />;
  const roles = data.roles.filter((r) => r.scope === tab);
  const perms = Object.entries(data.permissions).filter(([, d]) => !d.scope || d.scope === tab);
  const groups = [...new Set(perms.map(([, d]) => d.group))];

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-3">
        {!scope ? (
          <div className="flex items-center rounded-md border border-border bg-surface p-0.5">
            {(['PLATFORM', 'ORGANIZATION'] as const).map((t) => <button key={t} onClick={() => setTab(t)} className={`h-6 rounded px-2.5 text-[11.5px] ${tab === t ? 'bg-fg text-inverse' : 'text-muted hover:text-fg'}`}>{t === 'PLATFORM' ? 'Platform roles' : 'Workspace roles'}</button>)}
          </div>
        ) : <span />}
        {canManage && (scope === 'ORGANIZATION' || tab === 'PLATFORM') && <Button variant="primary" size="sm" onClick={() => setEditing('new')}><Plus /> Custom role</Button>}
      </div>
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-[12px]">
          <thead className="sticky top-0 bg-surface">
            <tr className="border-b border-border">
              <th className="w-[280px] px-4 py-2 text-left text-[10.5px] font-medium uppercase tracking-[0.08em] text-subtle">Permission</th>
              {roles.map((r) => (
                <th key={r.id} className="px-2 py-2 text-center align-bottom">
                  <button disabled={!canManage || r.isSystem} onClick={() => setEditing(r)} className="mx-auto flex max-w-[100px] flex-col items-center gap-0.5 enabled:hover:text-fg">
                    <span className="text-[11.5px] leading-tight font-medium text-fg-2">{r.name}</span>
                    <span className="flex items-center gap-1 text-[10px] text-subtle">{r.isSystem ? <><Lock className="size-2.5" /> system</> : 'custom'}{r.members != null && ` · ${r.members}`}</span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <Fragment key={g}>
                <tr><td colSpan={roles.length + 1} className="bg-surface-2 px-4 py-1.5 text-[10.5px] uppercase tracking-[0.1em] text-subtle">{g}</td></tr>
                {perms.filter(([, d]) => d.group === g).map(([k, d]) => (
                  <tr key={k} className="border-b border-border/50">
                    <td className="px-4 py-1.5"><div className="flex items-center gap-1.5 text-fg-2">{d.description}{d.sensitive && <Badge tone="warn">sensitive</Badge>}</div><div className="font-mono text-[10.5px] text-subtle">{k}</div></td>
                    {roles.map((r) => <td key={r.id} className="text-center">{r.permissions.includes(k) ? <Check className="mx-auto size-3.5 text-fg" aria-label="granted" /> : <span className="text-faint" aria-label="not granted">·</span>}</td>)}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </Card>
      {editing && <RoleDrawer endpoint={endpoint} role={editing === 'new' ? null : editing} scope={tab} perms={perms} groups={groups} onClose={() => setEditing(null)} />}
    </>
  );
}

function RoleDrawer({ endpoint, role, scope, perms, groups, onClose }: { endpoint: string; role: Role | null; scope: string; perms: [string, PermDef][]; groups: string[]; onClose: () => void }) {
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [sel, setSel] = useState<string[]>(role?.permissions ?? []);
  const save = useApiMutation(() => api(role ? `${endpoint}/${role.id}` : endpoint, { method: role ? 'PUT' : 'POST', body: { name, description: description || null, permissions: sel, scope } }), { success: 'Role saved', invalidate: [endpoint], onSuccess: onClose });
  const del = useApiMutation(() => api(`${endpoint}/${role!.id}`, { method: 'DELETE' }), { success: 'Role deleted', invalidate: [endpoint], onSuccess: onClose });
  const count = useMemo(() => sel.length, [sel]);
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={role ? `Edit ${role.name}` : 'New custom role'} description="You can only include permissions you hold yourself." width="lg"
      footer={<>{role && <Button variant="ghost" className="mr-auto text-danger" onClick={() => del.mutate(undefined)} loading={del.isPending}>Delete</Button>}<Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={name.trim().length < 2} onClick={() => save.mutate(undefined)}>Save ({count})</Button></>}>
      <div className="flex flex-col gap-4">
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Description"><Textarea value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        {groups.map((g) => (
          <Card key={g}>
            <CardHeader title={g} className="py-2" />
            <CardBody className="flex flex-col gap-2 py-3">
              {perms.filter(([, d]) => d.group === g).map(([k, d]) => (
                <label key={k} className={cn('flex cursor-pointer items-start gap-2 text-[12.5px]')}>
                  <Checkbox checked={sel.includes(k)} onCheckedChange={(c) => setSel(c ? [...sel, k] : sel.filter((x) => x !== k))} aria-label={k} />
                  <span><span className="text-fg-2">{d.description}</span>{d.sensitive && <Badge tone="warn" className="ml-1.5">sensitive</Badge>}<span className="block font-mono text-[10.5px] text-subtle">{k}</span></span>
                </label>
              ))}
            </CardBody>
          </Card>
        ))}
      </div>
    </Drawer>
  );
}
