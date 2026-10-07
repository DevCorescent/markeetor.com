import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { ALL_PERMISSIONS, type PermissionKey } from '@/lib/permissions';
import { audit } from '../audit';
import type { AuthContext } from '../auth/context';
import { prisma, withPlatform } from '../db';
import { AppError, forbidden, notFound } from '../errors';

/** Roles visible to the caller: platform staff see platform + template roles; tenants see templates + their own custom roles. */
export async function listRoles(ctx: AuthContext, opts: { scope?: 'PLATFORM' | 'ORGANIZATION'; organizationId?: string } = {}) {
  const where: Prisma.RoleWhereInput =
    ctx.scope === 'ORGANIZATION'
      ? { scope: 'ORGANIZATION', OR: [{ organizationId: null }, { organizationId: ctx.orgId }] }
      : {
          ...(opts.scope ? { scope: opts.scope } : {}),
          OR: [{ organizationId: null }, ...(opts.organizationId ? [{ organizationId: opts.organizationId }] : [])],
        };
  const roles = await prisma.role.findMany({
    where,
    orderBy: [{ scope: 'asc' }, { rank: 'desc' }, { name: 'asc' }],
    include: { permissions: { select: { permissionKey: true } }, _count: { select: { memberships: true } } },
  });
  return roles.map((r) => ({
    id: r.id, key: r.key, name: r.name, description: r.description, scope: r.scope, organizationId: r.organizationId,
    isSystem: r.isSystem, isPrivileged: r.isPrivileged, rank: r.rank,
    permissions: r.permissions.map((p) => p.permissionKey), members: ctx.scope === 'ORGANIZATION' && !r.organizationId ? undefined : r._count.memberships,
  }));
}

export const roleInput = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(300).optional().nullable(),
  permissions: z.array(z.string().max(80)).max(200),
  scope: z.enum(['PLATFORM', 'ORGANIZATION']).optional(),
});

function validatePermissions(ctx: AuthContext, scope: 'PLATFORM' | 'ORGANIZATION', permissions: string[]) {
  for (const p of permissions) {
    const def = Object.hasOwn(ALL_PERMISSIONS, p) ? ALL_PERMISSIONS[p as PermissionKey] : undefined;
    if (!def) throw new AppError('VALIDATION_FAILED', `Unknown permission: ${p}`);
    if (def.scope !== scope) throw new AppError('VALIDATION_FAILED', `${p} cannot be used in a ${scope.toLowerCase()} role`);
    // Tenants can't grant what they don't have; platform admins can compose org roles freely.
    if (ctx.scope === 'ORGANIZATION' && !ctx.permissions.has(p)) throw forbidden(`You cannot grant ${p} because you do not hold it`);
    if (ctx.scope === 'PLATFORM' && scope === 'PLATFORM' && !ctx.permissions.has(p)) throw forbidden(`You cannot grant ${p} because you do not hold it`);
  }
}

export async function createRole(ctx: AuthContext, input: z.infer<typeof roleInput>) {
  const scope = ctx.scope === 'ORGANIZATION' ? 'ORGANIZATION' : (input.scope ?? 'PLATFORM');
  validatePermissions(ctx, scope, input.permissions);
  const organizationId = ctx.scope === 'ORGANIZATION' ? ctx.orgId : null;
  if (ctx.scope === 'PLATFORM' && scope === 'ORGANIZATION') {
    throw new AppError('VALIDATION_FAILED', 'Workspace roles are created by workspace administrators. Platform-wide templates are managed in code.');
  }
  const key = `custom_${input.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40)}`;
  return withPlatform(async (tx) => {
    const exists = await tx.role.findFirst({ where: { organizationId, key } });
    if (exists) throw new AppError('CONFLICT', 'A role with this name already exists');
    const role = await tx.role.create({
      data: {
        key, name: input.name, description: input.description ?? null, scope, organizationId,
        rank: Math.max(1, ctx.role.rank - 1),
        permissions: { create: [...new Set(input.permissions)].map((permissionKey) => ({ permissionKey })) },
      },
    });
    await audit(tx, ctx, { action: 'role.created', targetType: 'role', targetId: role.id, after: { name: role.name, permissions: input.permissions } });
    return role;
  });
}

export async function updateRole(ctx: AuthContext, roleId: string, input: z.infer<typeof roleInput>) {
  return withPlatform(async (tx) => {
    const role = await tx.role.findUnique({ where: { id: roleId }, include: { permissions: true } });
    if (!role) throw notFound('Role');
    if (role.isSystem) throw forbidden('System roles cannot be modified. Create a custom role instead.');
    if (ctx.scope === 'ORGANIZATION' && role.organizationId !== ctx.orgId) throw notFound('Role');
    if (ctx.scope === 'PLATFORM' && role.organizationId) throw forbidden('Workspace roles are managed by the workspace');
    validatePermissions(ctx, role.scope, input.permissions);
    const before = role.permissions.map((p) => p.permissionKey).sort();
    await tx.rolePermission.deleteMany({ where: { roleId } });
    await tx.rolePermission.createMany({ data: [...new Set(input.permissions)].map((permissionKey) => ({ roleId, permissionKey })) });
    const updated = await tx.role.update({ where: { id: roleId }, data: { name: input.name, description: input.description ?? null } });
    await audit(tx, ctx, {
      action: 'role.updated', targetType: 'role', targetId: roleId, organizationId: role.organizationId,
      before: { name: role.name, permissions: before }, after: { name: input.name, permissions: [...input.permissions].sort() },
    });
    return updated;
  });
}

export async function deleteRole(ctx: AuthContext, roleId: string) {
  return withPlatform(async (tx) => {
    const role = await tx.role.findUnique({ where: { id: roleId }, include: { _count: { select: { memberships: true } } } });
    if (!role) throw notFound('Role');
    if (role.isSystem) throw forbidden('System roles cannot be deleted');
    if (ctx.scope === 'ORGANIZATION' && role.organizationId !== ctx.orgId) throw notFound('Role');
    if (role._count.memberships) throw new AppError('CONFLICT', 'Reassign members before deleting this role');
    await tx.role.delete({ where: { id: roleId } });
    await audit(tx, ctx, { action: 'role.deleted', targetType: 'role', targetId: roleId, organizationId: role.organizationId, before: { name: role.name } });
  });
}
