/**
 * Production-safe bootstrap. Unlike `prisma/seed.ts` (which refuses to run when
 * NODE_ENV=production and creates demo organizations, users and leads), this script
 * creates only what the application needs in order to function at all:
 *
 *   1. the permission catalog   (`permissions`)
 *   2. the system roles         (`roles` + `role_permissions`)
 *   3. optionally, the first platform owner, so the deployment is not locked out
 *
 * It writes no platform settings — the secure defaults in `src/server/settings.ts`
 * apply until an admin changes them in the UI (notably `mfaRequiredForPlatform: true`,
 * which the development seed deliberately relaxes).
 *
 *   npx tsx --env-file=.env scripts/bootstrap.ts
 *
 * To create the first owner, set these before running (they are read once and never stored):
 *   ADMIN_EMAIL=you@yourdomain.com
 *   ADMIN_PASSWORD=<a strong password>
 *
 * Re-running is safe: permissions and roles are upserted, and the owner is created
 * only when no platform user exists yet.
 */
import { PrismaClient } from '@prisma/client';
import { ALL_PERMISSIONS, SYSTEM_ROLES } from '../src/lib/permissions';
import { hashPassword, passwordProblems } from '../src/server/auth/password';
import { SETTING_DEFAULTS } from '../src/server/settings';

const prisma = new PrismaClient();

async function syncPermissionsAndRoles() {
  for (const [key, def] of Object.entries(ALL_PERMISSIONS)) {
    await prisma.permission.upsert({
      where: { key },
      create: { key, description: def.description, scope: def.scope, group: def.group, sensitive: Boolean(def.sensitive) },
      update: { description: def.description, scope: def.scope, group: def.group, sensitive: Boolean(def.sensitive) },
    });
  }
  const roles: Record<string, string> = {};
  for (const r of SYSTEM_ROLES) {
    // `key` is unique per organization, not globally, so the platform row is matched on both.
    const existing = await prisma.role.findFirst({ where: { key: r.key, organizationId: null } });
    const data = { name: r.name, description: r.description, scope: r.scope, rank: r.rank, isPrivileged: Boolean(r.isPrivileged), isSystem: true };
    const role = existing
      ? await prisma.role.update({ where: { id: existing.id }, data })
      : await prisma.role.create({ data: { key: r.key, ...data } });
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({ data: r.permissions.map((permissionKey) => ({ roleId: role.id, permissionKey })) });
    roles[r.key] = role.id;
  }
  return roles;
}

async function createFirstOwner(ownerRoleId: string) {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    console.log('▸ first owner: skipped (set ADMIN_EMAIL and ADMIN_PASSWORD to create one)');
    return;
  }

  const existing = await prisma.user.count({ where: { isPlatformUser: true } });
  if (existing > 0) {
    console.log(`▸ first owner: skipped (${existing} platform user(s) already exist)`);
    return;
  }

  // Enforce the same policy the application enforces on password changes.
  const minLength = SETTING_DEFAULTS['security.policy'].passwordMinLength;
  const problems = passwordProblems(password, minLength, [email]);
  if (problems.length) {
    throw new Error(`ADMIN_PASSWORD is not acceptable: ${problems.join('; ')}`);
  }

  const user = await prisma.user.create({
    data: {
      email,
      name: process.env.ADMIN_NAME?.trim() || 'Platform Owner',
      passwordHash: await hashPassword(password),
      status: 'ACTIVE',
      isPlatformUser: true,
      passwordChangedAt: new Date(),
      title: 'Platform Owner',
    },
  });
  await prisma.membership.create({ data: { userId: user.id, organizationId: null, roleId: ownerRoleId } });
  console.log(`▸ first owner: created ${email} with role platform_owner`);
  console.log('  Two-factor enrollment is required on first sign-in (mfaRequiredForPlatform defaults to true).');
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  console.log(`▸ target: ${url.replace(/:\/\/[^@]*@/, '://***@')}`);

  console.log('▸ permissions & system roles');
  const roles = await syncPermissionsAndRoles();
  const [permCount, roleCount] = await Promise.all([
    prisma.permission.count(),
    prisma.role.count({ where: { organizationId: null } }),
  ]);
  console.log(`  ${permCount} permissions, ${roleCount} system roles`);

  const ownerRoleId = roles.platform_owner;
  if (!ownerRoleId) throw new Error('SYSTEM_ROLES does not define platform_owner');
  await createFirstOwner(ownerRoleId);

  console.log('\n✓ Bootstrap complete. No demo data was created.');
}

main()
  .catch((err) => {
    console.error('\n✗ Bootstrap failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
