/**
 * Repeatable DEVELOPMENT seed. Every record created here is demo data:
 *   - organizations carry settings.demo = true and a "(Demo)" suffix
 *   - users use the reserved .test domain
 * Never run against production (guarded below).
 *
 *   npm run db:seed            # idempotent: upserts identities, skips data that already exists
 *   npm run db:reset           # drop, migrate and seed from scratch
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { hash } from '@node-rs/argon2';
import { ALL_PERMISSIONS, SYSTEM_ROLES } from '../src/lib/permissions';
import { DEFAULT_STAGES } from '../src/server/services/organizations';
import { normalizeEmail, normalizePhone } from '../src/server/services/normalize';
import { seedActivity } from './seed-activity';

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed a production database.');
  process.exit(1);
}

const prisma = new PrismaClient();
export const DEV_PASSWORD = process.env.SEED_PASSWORD ?? 'Demo-Passw0rd!2026';

// Deterministic PRNG so the seed produces the same data on every run.
let state = 0x2f6b9a1d;
const rand = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 0x100000000);
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

const FIRST = ['Aarav', 'Maya', 'Liam', 'Sofia', 'Noah', 'Isabella', 'Ethan', 'Zara', 'Lucas', 'Amara', 'Oliver', 'Priya', 'Mateo', 'Hana', 'Leo', 'Chloe', 'Arjun', 'Elena', 'Kai', 'Nina', 'Omar', 'Grace', 'Ravi', 'Ines', 'Daniel', 'Yuki', 'Samuel', 'Leila', 'Victor', 'Ana'];
const LAST = ['Sharma', 'Patel', 'Johnson', 'Garcia', 'Nguyen', 'Kim', 'Okafor', 'Rossi', 'Müller', 'Silva', 'Chen', 'Hughes', 'Khan', 'Andersen', 'Dubois', 'Tanaka', 'Mensah', 'Reyes', 'Novak', 'Walsh', 'Iyer', 'Costa', 'Fischer', 'Lopez'];
const COMPANIES = ['Brightline Logistics', 'Cobalt Health', 'Harbor & Pine', 'Meridian Foods', 'Northgate Capital', 'Orbit Fitness', 'Pinecrest Homes', 'Quartz Analytics', 'Redwood Dental', 'Saffron Hospitality', 'Tidewater Marine', 'Union Square Legal', 'Vantage Motors', 'Willow Education', 'Zenith Solar', 'Atlas Manufacturing', 'Beacon Retail', 'Cedar Insurance'];
const TITLES = ['Owner', 'CEO', 'Operations Manager', 'Head of Procurement', 'Marketing Director', 'Finance Manager', 'Founder', 'IT Manager', 'Office Manager', 'VP Sales'];
const INDUSTRIES = ['Real Estate', 'Insurance', 'Healthcare', 'Solar & Energy', 'Education', 'Automotive', 'Hospitality', 'Financial Services', 'Retail'];
const GEO: [country: string, state: string, city: string, cc: string, prefix: string][] = [
  ['United States', 'California', 'San Diego', 'US', '+1619'], ['United States', 'Texas', 'Austin', 'US', '+1512'],
  ['United States', 'New York', 'Brooklyn', 'US', '+1718'], ['United States', 'Florida', 'Tampa', 'US', '+1813'],
  ['India', 'Maharashtra', 'Pune', 'IN', '+9198'], ['India', 'Karnataka', 'Bengaluru', 'IN', '+9197'],
  ['United Kingdom', 'England', 'Manchester', 'GB', '+447700'], ['Canada', 'Ontario', 'Toronto', 'CA', '+1416'],
];
const SOURCES = ['Facebook Ads', 'Google Ads', 'Website Form', 'LinkedIn', 'Referral', 'Trade Show', 'Cold List'];
const CAMPAIGNS = ['Spring Home Buyers', 'Q3 Solar Rebate', 'Health Plan Renewal', 'Fleet Upgrade 2026', 'Webinar: Smart Insurance', 'Back to School'];

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

async function upsertUser(passwordHash: string, email: string, name: string, roleId: string, organizationId: string | null, title?: string) {
  const user = await prisma.user.upsert({
    where: { email },
    create: { email, name, passwordHash, status: 'ACTIVE', isPlatformUser: organizationId === null, passwordChangedAt: new Date(), title },
    update: { name, title },
  });
  await prisma.membership.upsert({ where: { userId: user.id }, create: { userId: user.id, organizationId, roleId }, update: { organizationId, roleId } });
  return user;
}

type Tx = Prisma.TransactionClient;
async function platform<T>(fn: (tx: Tx) => Promise<T>) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    return fn(tx);
  }, { timeout: 120_000 });
}

async function main() {
  console.log('▸ permissions & system roles');
  const roles = await syncPermissionsAndRoles();

  console.log('▸ development platform settings (demo — MFA enforcement relaxed for local sign-in)');
  await prisma.platformSetting.upsert({
    where: { key: 'security.policy' },
    create: { key: 'security.policy', value: { mfaRequiredForPlatform: false } },
    update: {},
  });
  await prisma.platformSetting.upsert({ where: { key: 'dashboard.demoDataLabel' }, create: { key: 'dashboard.demoDataLabel', value: { enabled: true } }, update: { value: { enabled: true } } });

  const pw = await hash(DEV_PASSWORD, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 });

  console.log('▸ platform staff');
  const owner = await upsertUser(pw, 'owner@leadscrm.test', 'Olivia Hart', roles.platform_owner, null, 'Platform Owner');
  await upsertUser(pw, 'admin@leadscrm.test', 'Marcus Reid', roles.super_admin, null, 'Super Admin');
  await upsertUser(pw, 'ops@leadscrm.test', 'Priya Nair', roles.lead_ops_manager, null, 'Lead Operations');
  await upsertUser(pw, 'security@leadscrm.test', 'Daniel Brooks', roles.security_admin, null, 'Security');
  await upsertUser(pw, 'analyst@leadscrm.test', 'Hannah Cole', roles.analytics_admin, null, 'Analytics');

  console.log('▸ demo client organizations');
  const orgDefs = [
    { slug: 'northwind-realty', code: 'ORG-NWR001', name: 'Northwind Realty (Demo)', industry: 'Real Estate', regions: ['United States'], industries: ['Real Estate', 'Financial Services'], weight: 3, domain: 'northwind' },
    { slug: 'apex-insurance', code: 'ORG-APX002', name: 'Apex Insurance Brokers (Demo)', industry: 'Insurance', regions: ['United States', 'Canada'], industries: ['Insurance', 'Healthcare', 'Automotive'], weight: 2, domain: 'apex' },
    { slug: 'summit-solar', code: 'ORG-SUM003', name: 'Summit Solar (Demo)', industry: 'Solar & Energy', regions: ['India', 'United Kingdom'], industries: ['Solar & Energy', 'Education', 'Hospitality', 'Retail'], weight: 1, domain: 'summit' },
  ];
  const orgs: { id: string; domain: string }[] = [];
  for (const d of orgDefs) {
    const org = await prisma.organization.upsert({
      where: { slug: d.slug },
      create: {
        slug: d.slug, code: d.code, name: d.name, industry: d.industry, contactEmail: `ops@${d.domain}.test`, timezone: 'UTC', createdById: owner.id,
        settings: { demo: true, features: {}, security: { watermark: true } },
        quota: { create: { weight: d.weight, regions: d.regions, industries: d.industries, maxActiveLeads: 400, dailyAllocationLimit: 300 } },
      },
      update: {},
    });
    orgs.push({ id: org.id, domain: d.domain });
    await platform(async (tx) => {
      if (!(await tx.pipeline.findFirst({ where: { organizationId: org.id } }))) {
        const p = await tx.pipeline.create({ data: { organizationId: org.id, name: 'Sales pipeline', isDefault: true } });
        await tx.pipelineStage.createMany({ data: DEFAULT_STAGES.map((s, i) => ({ organizationId: org.id, pipelineId: p.id, position: i, ...s })) });
      }
    });
    const people = [
      ['owner', 'client_owner', `${pick(FIRST)} ${pick(LAST)}`, 'Managing Director'],
      ['admin', 'client_admin', `${pick(FIRST)} ${pick(LAST)}`, 'Operations Admin'],
      ['manager', 'sales_manager', `${pick(FIRST)} ${pick(LAST)}`, 'Sales Manager'],
      ['rep1', 'sales_executive', `${pick(FIRST)} ${pick(LAST)}`, 'Account Executive'],
      ['rep2', 'sales_executive', `${pick(FIRST)} ${pick(LAST)}`, 'Account Executive'],
      ['analyst', 'read_only_analyst', `${pick(FIRST)} ${pick(LAST)}`, 'Analyst'],
    ] as const;
    const members: Record<string, string> = {};
    for (const [handle, roleKey, name, title] of people) {
      const u = await upsertUser(pw, `${handle}@${d.domain}.test`, name, roles[roleKey], org.id, title);
      members[handle] = u.id;
    }
    await platform(async (tx) => {
      if (!(await tx.team.findFirst({ where: { organizationId: org.id } }))) {
        const team = await tx.team.create({ data: { organizationId: org.id, name: 'Inside Sales', managerId: members.manager } });
        await tx.teamMember.createMany({
          data: ['manager', 'rep1', 'rep2'].map((h) => ({ teamId: team.id, userId: members[h], organizationId: org.id })),
        });
      }
    });
  }

  const existingLeads = await platform((tx) => tx.lead.count());
  if (existingLeads === 0) {
    console.log('▸ demo leads (deterministic)');
    const rows: Prisma.LeadCreateManyInput[] = [];
    const now = Date.now();
    for (let i = 0; i < 900; i++) {
      const first = pick(FIRST);
      const last = pick(LAST);
      const [country, st, city, cc, prefix] = pick(GEO);
      const company = pick(COMPANIES);
      const invalid = rand() < 0.04;
      const email = invalid && rand() < 0.5 ? `${first.toLowerCase()}.${last.toLowerCase()}@` : `${first}.${last}${i}@${company.toLowerCase().replace(/[^a-z]/g, '')}.test`;
      const phoneRaw = invalid && rand() >= 0.5 ? '12345' : `${prefix}${String(int(1000000, 9999999)).padStart(7, '0')}`.slice(0, 13);
      const e = normalizeEmail(email);
      const p = normalizePhone(phoneRaw, cc);
      const issues = [...(e.error ? [e.error] : []), ...(p.error ? [p.error] : [])];
      rows.push({
        fullName: `${first} ${last}`,
        email,
        emailNormalized: e.value,
        phone: phoneRaw,
        phoneNormalized: p.value,
        company,
        jobTitle: pick(TITLES),
        country, state: st, city,
        industry: pick(INDUSTRIES),
        source: pick(SOURCES),
        campaign: rand() < 0.8 ? pick(CAMPAIGNS) : null,
        score: int(5, 98),
        priority: pick(['LOW', 'MEDIUM', 'MEDIUM', 'HIGH', 'URGENT'] as const),
        quality: issues.length ? 'INVALID' : 'VALID',
        qualityIssues: issues,
        createdAt: new Date(now - int(0, 120) * 86400_000 - int(0, 86400_000)),
        createdById: owner.id,
        customFields: { budget: pick(['< $10k', '$10k–$50k', '$50k+']) },
      });
    }
    await platform((tx) => tx.lead.createMany({ data: rows }));
  }
  // Starter marketing library (only when empty — admins curate it afterwards).
  if ((await platform((tx) => tx.marketingTemplate.count())) === 0) {
    console.log('▸ marketing template library');
    const seq = (name: string, steps: { type: 'whatsapp' | 'sms' | 'task'; delayHours: number; body?: string; title?: string }[]) => ({ name, steps: steps.map((st, i) => ({ id: `s${i + 1}`, templateId: null, body: st.body ?? null, title: st.title ?? null, ...st })), stopOnReply: true, stopOnStatus: ['CONVERTED', 'LOST'], segmentId: null, autoEnroll: false });
    await platform((tx) => tx.marketingTemplate.createMany({ data: [
      { kind: 'SEQUENCE', name: 'New lead — 3-touch follow-up', description: 'WhatsApp intro now, call task after 1 day, WhatsApp nudge after 3 days.', createdById: owner.id, content: seq('New lead — 3-touch follow-up', [
        { type: 'whatsapp', delayHours: 0, body: 'Hi {first_name|there} 👋 This is {sender_name} from {workspace}. Thanks for your interest — when is a good time for a quick call?' },
        { type: 'task', delayHours: 24, title: 'Call {first_name} to qualify' },
        { type: 'whatsapp', delayHours: 48, body: 'Hi {first_name|there}, just following up — happy to share pricing and a few examples. Shall I send them here?' },
      ]) },
      { kind: 'SEQUENCE', name: 'Re-engage cold leads', description: 'Two gentle messages a week apart, then a final call task.', createdById: owner.id, content: seq('Re-engage cold leads', [
        { type: 'whatsapp', delayHours: 0, body: 'Hi {first_name|there}, it’s {sender_name} from {workspace}. We have a new offer that may suit {company|your business} — interested?' },
        { type: 'sms', delayHours: 168, body: '{workspace}: Hi {first_name|there}, still looking? Reply YES and we’ll call you. STOP to opt out' },
        { type: 'task', delayHours: 48, title: 'Last try: call {first_name}' },
      ]) },
      { kind: 'WHATSAPP', name: 'Meeting reminder', description: 'Send the day before a meeting.', createdById: owner.id, content: { body: 'Hi {first_name|there}, a quick reminder of our meeting tomorrow. Reply here if you need to reschedule. — {sender_name}, {workspace}' } },
      { kind: 'SMS', name: 'Missed call', description: 'After an unanswered call.', createdById: owner.id, content: { body: '{workspace}: Sorry we missed you, {first_name|there}. When can we call back? STOP to opt out' } },
    ] }));
  }
  // Additive and run once: allocates remaining demo leads and backfills CRM history.
  if (!(await prisma.platformSetting.findUnique({ where: { key: 'seed.activity' } }))) {
    await seedActivity(prisma, owner.id);
    await prisma.platformSetting.create({ data: { key: 'seed.activity', value: { at: new Date().toISOString() } } });
  }
  console.log(`\n✓ Seed complete. Demo sign-in password for all *.test users: see SEED_PASSWORD in .env.example`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
