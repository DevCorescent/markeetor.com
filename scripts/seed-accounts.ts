/**
 * Creates the real platform administrator plus one demo account per system role, so every
 * role can be signed into and exercised.
 *
 * Unlike `prisma/seed.ts` this runs with NODE_ENV=production and creates no leads, imports
 * or activity — only identities and the one workspace the ORGANIZATION-scoped roles need.
 *
 *   npx tsx --tsconfig tsconfig.json --env-file=.env scripts/seed-accounts.ts
 *
 * Requires `scripts/bootstrap.ts` to have run first (it creates the roles these reference).
 *
 * Demo accounts all use the reserved `.test` TLD, so none of them can receive real mail,
 * and their organization is tagged `settings.demo = true`.
 */
import { PrismaClient } from '@prisma/client';
import { SYSTEM_ROLES } from '../src/lib/permissions';
import { hashPassword, passwordProblems } from '../src/server/auth/password';
import { DEFAULT_STAGES } from '../src/server/services/organizations';
import { SETTING_DEFAULTS } from '../src/server/settings';

const prisma = new PrismaClient();

/**
 * The operator's real account. Everything else on this list is demo.
 * The password is never hardcoded — this file is in version control.
 *   ADMIN_PASSWORD='…' npm run db:seed:accounts
 */
const ADMIN = {
  email: process.env.ADMIN_EMAIL ?? 'kushagra@corescent.in',
  name: process.env.ADMIN_NAME ?? 'Kushagra',
  title: 'Platform Owner',
  roleKey: 'platform_owner',
  password: process.env.ADMIN_PASSWORD,
};

/** Shared password for the `.test` demo accounts, so each role is easy to sign into. */
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'Demo-Passw0rd!2026';

const DEMO_DOMAIN = 'demo.markeetor.test';

const PLATFORM_DEMO = [
  { handle: 'super.admin', roleKey: 'super_admin', name: 'Dana Whitfield', title: 'Super Admin' },
  { handle: 'lead.ops', roleKey: 'lead_ops_manager', name: 'Rohit Malhotra', title: 'Lead Operations Manager' },
  { handle: 'security', roleKey: 'security_admin', name: 'Ingrid Sorensen', title: 'Security Administrator' },
  { handle: 'analytics', roleKey: 'analytics_admin', name: 'Tomas Vega', title: 'Analytics Administrator' },
];

const ORG_DEMO = [
  { handle: 'client.owner', roleKey: 'client_owner', name: 'Meera Raghavan', title: 'Managing Director' },
  { handle: 'client.admin', roleKey: 'client_admin', name: 'Felix Brandt', title: 'Operations Admin' },
  { handle: 'sales.manager', roleKey: 'sales_manager', name: 'Aisha Bakare', title: 'Sales Manager' },
  { handle: 'sales.exec', roleKey: 'sales_executive', name: 'Jonas Lindqvist', title: 'Account Executive' },
  { handle: 'analyst', roleKey: 'read_only_analyst', name: 'Priya Deshmukh', title: 'Analyst' },
  // The plain extra user, so there is a second rep to assign and transfer leads between.
  { handle: 'dummy.user', roleKey: 'sales_executive', name: 'Dummy Tester', title: 'Account Executive (test)' },
];

type Row = { email: string; role: string; scope: string; created: boolean };
const summary: Row[] = [];

async function roleMap() {
  const rows = await prisma.role.findMany({ where: { organizationId: null }, select: { id: true, key: true, scope: true } });
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const missing = SYSTEM_ROLES.filter((r) => !byKey.has(r.key)).map((r) => r.key);
  if (missing.length) throw new Error(`System roles missing (run scripts/bootstrap.ts first): ${missing.join(', ')}`);
  return byKey;
}

async function upsertUser(args: {
  email: string; name: string; title: string; passwordHash: string; roleId: string; organizationId: string | null;
}) {
  const existing = await prisma.user.findUnique({ where: { email: args.email }, select: { id: true } });
  const user = await prisma.user.upsert({
    where: { email: args.email },
    create: {
      email: args.email,
      name: args.name,
      title: args.title,
      passwordHash: args.passwordHash,
      status: 'ACTIVE',
      isPlatformUser: args.organizationId === null,
      passwordChangedAt: new Date(),
    },
    // Reset the password on re-run so these accounts are always usable.
    update: { name: args.name, title: args.title, passwordHash: args.passwordHash, status: 'ACTIVE' },
    select: { id: true },
  });
  await prisma.membership.upsert({
    where: { userId: user.id },
    create: { userId: user.id, organizationId: args.organizationId, roleId: args.roleId },
    update: { organizationId: args.organizationId, roleId: args.roleId },
  });
  return { id: user.id, created: !existing };
}

async function ensureDemoOrg(createdById: string) {
  const org = await prisma.organization.upsert({
    where: { slug: 'demo-workspace' },
    create: {
      slug: 'demo-workspace',
      code: 'ORG-DEMO01',
      name: 'Demo Workspace (Demo)',
      industry: 'Real Estate',
      contactEmail: `ops@${DEMO_DOMAIN}`,
      timezone: 'UTC',
      createdById,
      settings: { demo: true, features: {}, security: { watermark: true } },
      quota: {
        create: { weight: 1, regions: ['India', 'United States'], industries: ['Real Estate', 'Insurance'], maxActiveLeads: 400, dailyAllocationLimit: 300 },
      },
    },
    update: {},
    select: { id: true },
  });

  // The CRM needs a default pipeline before a workspace user can move a lead through stages.
  // pipelines/pipeline_stages are RLS-protected, so this runs with the platform bypass.
  const existing = await prisma.pipeline.findFirst({ where: { organizationId: org.id }, select: { id: true } });
  if (!existing) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      const p = await tx.pipeline.create({ data: { organizationId: org.id, name: 'Sales pipeline', isDefault: true } });
      await tx.pipelineStage.createMany({
        data: DEFAULT_STAGES.map((s, i) => ({ organizationId: org.id, pipelineId: p.id, position: i, ...s })),
      });
    });
  }
  return org.id;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  console.log(`▸ target: ${url.replace(/:\/\/[^@]*@/, '://***@')}\n`);

  if (!ADMIN.password) {
    throw new Error('ADMIN_PASSWORD is required (it is deliberately not stored in this file). Example:\n  ADMIN_PASSWORD=\'your-password\' npm run db:seed:accounts');
  }

  const minLength = SETTING_DEFAULTS['security.policy'].passwordMinLength;
  const toCheck: { label: string; password: string; context: string[] }[] = [
    { label: 'ADMIN_PASSWORD', password: ADMIN.password, context: [ADMIN.email, ADMIN.name] },
    { label: 'DEMO_PASSWORD', password: DEMO_PASSWORD, context: [] },
  ];
  for (const { label, password, context } of toCheck) {
    const problems = passwordProblems(password, minLength, context);
    if (problems.length) throw new Error(`${label} is not acceptable: ${problems.join('; ')}`);
  }

  const roles = await roleMap();

  // Two-factor enforcement is left ALONE by default: platform users enroll on first sign-in,
  // which is the correct production posture. Pass RELAX_MFA=1 only for a throwaway environment.
  if (process.env.RELAX_MFA === '1') {
    await prisma.platformSetting.upsert({
      where: { key: 'security.policy' },
      create: { key: 'security.policy', value: { mfaRequiredForPlatform: false } },
      update: { value: { mfaRequiredForPlatform: false } },
    });
    console.log('▸ platform settings: MFA enforcement OFF (RELAX_MFA=1) — do not do this in production');
  }
  // Label demo data in the UI, since these accounts live beside real ones.
  await prisma.platformSetting.upsert({
    where: { key: 'dashboard.demoDataLabel' },
    create: { key: 'dashboard.demoDataLabel', value: { enabled: true } },
    update: { value: { enabled: true } },
  });

  console.log('▸ administrator');
  const adminHash = await hashPassword(ADMIN.password);
  const admin = await upsertUser({
    email: ADMIN.email, name: ADMIN.name, title: ADMIN.title,
    passwordHash: adminHash, roleId: roles.get(ADMIN.roleKey)!.id, organizationId: null,
  });
  summary.push({ email: ADMIN.email, role: ADMIN.roleKey, scope: 'PLATFORM', created: admin.created });

  const demoHash = await hashPassword(DEMO_PASSWORD);

  console.log('▸ platform demo accounts');
  for (const p of PLATFORM_DEMO) {
    const email = `${p.handle}@${DEMO_DOMAIN}`;
    const r = await upsertUser({ email, name: p.name, title: p.title, passwordHash: demoHash, roleId: roles.get(p.roleKey)!.id, organizationId: null });
    summary.push({ email, role: p.roleKey, scope: 'PLATFORM', created: r.created });
  }

  console.log('▸ demo workspace');
  const orgId = await ensureDemoOrg(admin.id);

  console.log('▸ workspace demo accounts');
  for (const p of ORG_DEMO) {
    const email = `${p.handle}@${DEMO_DOMAIN}`;
    const r = await upsertUser({ email, name: p.name, title: p.title, passwordHash: demoHash, roleId: roles.get(p.roleKey)!.id, organizationId: orgId });
    summary.push({ email, role: p.roleKey, scope: 'ORGANIZATION', created: r.created });
  }

  // Every system role must be represented, or a role cannot be exercised at all.
  const covered = new Set(summary.map((s) => s.role));
  const uncovered = SYSTEM_ROLES.filter((r) => !covered.has(r.key)).map((r) => r.key);

  console.log('\n┌─ accounts ──────────────────────────────────────────────────────────────────');
  for (const s of summary) {
    console.log(`│ ${s.created ? '+' : '='} ${s.email.padEnd(34)} ${s.role.padEnd(19)} ${s.scope}`);
  }
  console.log('└─────────────────────────────────────────────────────────────────────────────');
  console.log(`  (+ created, = already existed and password reset)`);
  console.log(`\n  roles covered : ${covered.size}/${SYSTEM_ROLES.length}${uncovered.length ? ` — MISSING: ${uncovered.join(', ')}` : ''}`);
  console.log(`  admin         : ${ADMIN.email} (password as supplied in ADMIN_PASSWORD)`);
  console.log(`  demo accounts : ${DEMO_PASSWORD}`);
  if (process.env.RELAX_MFA === '1') {
    console.log('\n  WARNING: two-factor enforcement is OFF. Re-enable it before real use:');
    console.log(`    UPDATE platform_settings SET value = '{"mfaRequiredForPlatform": true}' WHERE key = 'security.policy';`);
  } else {
    console.log('\n  Platform users enroll two-factor authentication on first sign-in.');
  }

  if (uncovered.length) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('\n✗ Failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
