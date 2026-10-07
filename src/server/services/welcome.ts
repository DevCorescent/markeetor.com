import { Prisma } from '@prisma/client';
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { DEFAULT_SETTINGS } from '@/lib/email/render';
import type { EmailDesign, Variables } from '@/lib/email/types';
import { audit } from '../audit';
import { assertCan, type AuthContext } from '../auth/context';
import { hashPassword } from '../auth/password';
import { randomToken, sha256 } from '../crypto';
import { prisma, withPlatform } from '../db';
import { AppError, notFound } from '../errors';
import { enqueue } from '../jobs/queues';
import { getSetting } from '../settings';
import { designSchema } from './email';
import { insertOrganization } from './organizations';

/**
 * Welcome emails: when an import adds new leads to the repository, each lead with a valid email gets
 * their own client workspace (as Client Owner) and an email with a temporary password. The password
 * only ever exists in memory while that one email is rendered; the account must replace it on first
 * sign-in and it stops working after `passwordExpiryDays`.
 *
 * Sends are ordinary platform campaigns (audience kind "welcome"), so they inherit sender limits,
 * retries, unsubscribe handling and the delivery log. Accounts are created at send time, one per
 * message, so cancelling a scheduled welcome campaign creates nothing.
 */

const SETTING_KEY = 'email.welcome';

const isTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export const welcomeSettingsSchema = z.object({
  enabled: z.boolean(),
  /** Platform sender; null uses the platform's default sender. */
  smtpAccountId: z.string().max(64).nullable(),
  /** Lead sources to welcome (case-insensitive). Empty means every source. */
  sources: z.array(z.string().trim().min(1).max(120)).max(200),
  timing: z.enum(['immediate', 'delay', 'daily']),
  delayMinutes: z.number().int().min(1).max(7 * 24 * 60),
  dailyTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)'),
  timezone: z.string().trim().max(60).refine(isTimeZone, 'Unknown time zone'),
  passwordExpiryDays: z.number().int().min(1).max(30),
  subject: z.string().trim().min(1).max(300).refine((s) => !/\{\{\s*temporaryPassword\s*\}\}/.test(s), 'The temporary password cannot go in the subject line'),
  preheader: z.string().trim().max(300).nullable(),
  design: designSchema,
});
export type WelcomeSettings = z.infer<typeof welcomeSettingsSchema>;

export function defaultWelcomeDesign(): EmailDesign {
  return {
    version: 1,
    settings: { ...DEFAULT_SETTINGS },
    blocks: [
      { id: 'w1', type: 'heading', text: 'Welcome to {{organizationName}}, {{firstName}}', level: 2, align: 'left' },
      { id: 'w2', type: 'text', align: 'left', html: '<p>We’ve set up your own workspace, <strong>{{workspaceName}}</strong>. Use the details below to sign in.</p>' },
      { id: 'w3', type: 'text', align: 'left', html: '<p>Username: <strong>{{username}}</strong><br/>Temporary password: <strong><code>{{temporaryPassword}}</code></strong></p>' },
      { id: 'w4', type: 'button', label: 'Sign in', url: '{{loginUrl}}', align: 'left', variant: 'solid', fullWidth: false },
      { id: 'w5', type: 'text', align: 'left', html: '<p>For your security, you’ll be asked to <strong>choose your own password</strong> the first time you sign in. The temporary password stops working on {{passwordExpiresOn}}.</p><p>If you weren’t expecting this email, you can ignore it.</p>' },
      { id: 'w6', type: 'footer', html: '<p>{{organizationName}} · {{currentYear}}</p><p><a href="{{unsubscribeUrl}}">Unsubscribe</a></p>' },
    ],
  };
}

export function defaultWelcomeSettings(): WelcomeSettings {
  return {
    enabled: false,
    smtpAccountId: null,
    sources: [],
    timing: 'immediate',
    delayMinutes: 60,
    dailyTime: '10:00',
    timezone: 'UTC',
    passwordExpiryDays: 7,
    subject: 'Welcome to {{organizationName}} — your sign-in details',
    preheader: 'Your workspace is ready. Sign in and choose your password.',
    design: defaultWelcomeDesign() as WelcomeSettings['design'],
  };
}

export async function getWelcomeSettings(): Promise<WelcomeSettings> {
  const row = await prisma.platformSetting.findUnique({ where: { key: SETTING_KEY } });
  const merged = { ...defaultWelcomeSettings(), ...((row?.value as object) ?? {}) };
  const parsed = welcomeSettingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : defaultWelcomeSettings();
}

/** The platform sender welcome emails go out from, or null when none is usable. */
async function resolveSender(s: Pick<WelcomeSettings, 'smtpAccountId'>) {
  return withPlatform(async (tx) => {
    if (s.smtpAccountId) return tx.smtpAccount.findFirst({ where: { id: s.smtpAccountId, organizationId: null, deletedAt: null, status: { not: 'FAILED' } } });
    return (
      (await tx.smtpAccount.findFirst({ where: { organizationId: null, deletedAt: null, isDefault: true, status: { not: 'FAILED' } } })) ??
      (await tx.smtpAccount.findFirst({ where: { organizationId: null, deletedAt: null, status: 'VERIFIED' }, orderBy: { createdAt: 'asc' } }))
    );
  });
}

export async function saveWelcomeSettings(ctx: AuthContext, input: WelcomeSettings) {
  assertCan(ctx, 'orgs.create');
  const s = welcomeSettingsSchema.parse(input);
  if (s.enabled) {
    if (!(await resolveSender(s))) throw new AppError('PRECONDITION_FAILED', 'Add and verify a platform sender (Email → Senders) before turning on welcome emails');
    const body = JSON.stringify(s.design.blocks);
    if (!body.includes('temporaryPassword') || !body.includes('username')) {
      throw new AppError('VALIDATION_FAILED', 'The welcome email must include {{username}} and {{temporaryPassword}} so leads can sign in');
    }
  }
  const before = await getWelcomeSettings();
  await withPlatform(async (tx) => {
    const value = s as unknown as Prisma.InputJsonValue;
    await tx.platformSetting.upsert({ where: { key: SETTING_KEY }, create: { key: SETTING_KEY, value, updatedById: ctx.user.id }, update: { value, updatedById: ctx.user.id } });
    await audit(tx, ctx, {
      action: 'settings.email.welcome.updated', targetType: 'platform_setting', targetId: SETTING_KEY, organizationId: null,
      before: { enabled: before.enabled, timing: before.timing, sources: before.sources, smtpAccountId: before.smtpAccountId },
      after: { enabled: s.enabled, timing: s.timing, sources: s.sources, smtpAccountId: s.smtpAccountId },
    });
  });
  return s;
}

// ── Scheduling ─────────────────────────────────────────────────────

/** Next moment the wall clock in `timeZone` reads `time` (HH:MM), strictly after `now`. */
export function nextTimeOfDay(time: string, timeZone: string, now = new Date()) {
  const [h, m] = time.split(':').map(Number);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(now).map((p) => [p.type, p.value]),
  );
  const nowMinutes = Number(parts.hour) * 60 + Number(parts.minute) + Number(parts.second) / 60;
  let diff = h * 60 + m - nowMinutes;
  if (diff <= 0) diff += 24 * 60;
  return new Date(Math.round((now.getTime() + diff * 60_000) / 60_000) * 60_000);
}

export function welcomeSendTime(s: Pick<WelcomeSettings, 'timing' | 'delayMinutes' | 'dailyTime' | 'timezone'>, now = new Date()): Date | null {
  if (s.timing === 'delay') return new Date(now.getTime() + s.delayMinutes * 60_000);
  if (s.timing === 'daily') return nextTimeOfDay(s.dailyTime, s.timezone, now);
  return null;
}

type WelcomeAudience = { kind: 'welcome'; importId: string; passwordExpiryDays: number; timezone: string };

export const isWelcomeAudience = (a: unknown): a is WelcomeAudience => (a as { kind?: string } | null)?.kind === 'welcome';

const findWelcomeCampaign = (importId: string) =>
  withPlatform((tx) => tx.emailCampaign.findFirst({ where: { organizationId: null, audience: { path: ['importId'], equals: importId } }, orderBy: { createdAt: 'desc' } }));

/**
 * Queues the welcome campaign for one completed import: every lead the import inserted, filtered by
 * source. Called by the import worker on completion; `manual` (an admin's "Send now") ignores the
 * on/off switch and the schedule. Never queues the same import twice.
 */
export async function queueWelcomeForImport(importId: string, opts: { manual?: { ctx: AuthContext } } = {}): Promise<{ campaignId: string | null; reason?: string }> {
  const s = await getWelcomeSettings();
  const fail = (code: 'CONFLICT' | 'PRECONDITION_FAILED' | 'VALIDATION_FAILED', reason: string) => {
    if (opts.manual) throw new AppError(code, reason);
    return { campaignId: null, reason };
  };
  if (!s.enabled && !opts.manual) return { campaignId: null, reason: 'Welcome emails are turned off' };
  const batch = await withPlatform((tx) => tx.importBatch.findUnique({ where: { id: importId } }));
  if (!batch) throw notFound('Import');
  if (batch.status !== 'COMPLETED') return fail('CONFLICT', 'Only completed imports can be welcomed');
  if (await findWelcomeCampaign(importId)) return fail('CONFLICT', 'Welcome emails were already queued for this import');
  const sender = await resolveSender(s);
  if (!sender) return fail('PRECONDITION_FAILED', 'No usable platform sender. Add one in Email → Senders.');

  const rows = await withPlatform((tx) => tx.importRow.findMany({ where: { importId, status: 'INSERTED', leadId: { not: null } }, select: { leadId: true } }));
  const ids = rows.map((r) => r.leadId!);
  const sources = new Set(s.sources.map((x) => x.toLowerCase()));
  const leads: { id: string; fullName: string; emailNormalized: string | null }[] = [];
  for (let i = 0; i < ids.length; i += 5000) {
    const chunk = await withPlatform((tx) => tx.lead.findMany({ where: { id: { in: ids.slice(i, i + 5000) }, archivedAt: null, mergedIntoId: null }, select: { id: true, fullName: true, emailNormalized: true, source: true } }));
    leads.push(...chunk.filter((l) => !sources.size || (l.source && sources.has(l.source.toLowerCase()))));
  }
  if (!leads.length) return fail('VALIDATION_FAILED', sources.size ? 'No new leads from the selected sources in this import' : 'This import added no new leads');

  const emails = [...new Set(leads.map((l) => l.emailNormalized).filter(Boolean) as string[])];
  const suppressed = new Set<string>();
  const existing = new Set<string>();
  for (let i = 0; i < emails.length; i += 5000) {
    const slice = emails.slice(i, i + 5000);
    const [sup, users] = await withPlatform((tx) => Promise.all([
      tx.emailSuppression.findMany({ where: { organizationId: null, emailHash: { in: slice.map(sha256) } }, select: { emailHash: true } }),
      tx.user.findMany({ where: { email: { in: slice } }, select: { email: true } }),
    ]));
    sup.forEach((r) => suppressed.add(r.emailHash));
    users.forEach((u) => existing.add(u.email));
  }
  const seen = new Set<string>();
  const list = leads.map((l) => {
    const email = l.emailNormalized;
    let skip: string | null = null;
    if (!email) skip = 'No valid email address';
    else if (suppressed.has(sha256(email))) skip = 'Unsubscribed or suppressed';
    else if (existing.has(email)) skip = 'Already has an account';
    else if (seen.has(email)) skip = 'Duplicate address in this campaign';
    if (email) seen.add(email);
    return { ...l, skip };
  });
  const sendable = list.filter((r) => !r.skip).length;

  const at = opts.manual ? null : welcomeSendTime(s);
  const actorId = opts.manual?.ctx.user.id ?? batch.createdById;
  const audience: WelcomeAudience = { kind: 'welcome', importId, passwordExpiryDays: s.passwordExpiryDays, timezone: s.timezone };
  const campaign = await withPlatform(async (tx) => {
    const c = await tx.emailCampaign.create({
      data: {
        organizationId: null, name: `Welcome · ${batch.code}`, smtpAccountId: sender.id, subject: s.subject, preheader: s.preheader,
        design: s.design as unknown as Prisma.InputJsonValue, status: !sendable ? 'COMPLETED' : at ? 'SCHEDULED' : 'QUEUED', audience: audience as unknown as Prisma.InputJsonValue,
        trackOpens: true, scheduledFor: at, totalRecipients: list.length, skippedCount: list.length - sendable, createdById: actorId, completedAt: sendable ? null : new Date(),
      },
    });
    const now = new Date();
    for (let i = 0; i < list.length; i += 2000) {
      await tx.emailMessage.createMany({
        data: list.slice(i, i + 2000).map((r) => ({
          organizationId: null, campaignId: c.id, smtpAccountId: sender.id, leadId: r.id, toEmail: r.emailNormalized ?? '', toName: r.fullName,
          subject: s.subject, status: r.skip ? ('SKIPPED' as const) : ('QUEUED' as const), error: r.skip, trackingToken: randomToken(18), queuedAt: now,
        })),
      });
    }
    await audit(tx, opts.manual?.ctx ?? { user: { id: actorId, email: '', name: 'import worker', mfaEnabled: false } }, {
      action: 'email.welcome.queued', targetType: 'email_campaign', targetId: c.id, organizationId: null,
      metadata: { importId, import: batch.code, recipients: list.length, sendable, scheduledFor: at, manual: Boolean(opts.manual) },
    });
    return c;
  }, { timeout: 120_000 });
  if (sendable) await enqueue('email', 'campaign', { campaignId: campaign.id }, { jobId: `campaign-${campaign.id}-${Date.now()}`, delay: at ? Math.max(0, at.getTime() - Date.now()) : 0 });
  return { campaignId: campaign.id };
}

// ── Accounts ───────────────────────────────────────────────────────

// No look-alike characters (0/O, 1/l/I) and only symbols that survive copy-paste from an email.
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';
const SYMBOLS = '#%+=?@-';

/** A random temporary password with every character class, long enough for the platform password policy. */
export function generateTempPassword(length = 14) {
  const all = UPPER + LOWER + DIGITS + SYMBOLS;
  const pick = (set: string) => set[randomInt(set.length)];
  const chars = [pick(UPPER), pick(LOWER), pick(DIGITS), pick(SYMBOLS)];
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/**
 * Worker, immediately before a welcome message is sent: creates the lead's workspace and Client Owner
 * account with a fresh temporary password, and returns the variables for that one email. A retry of
 * the same message (`priorAttempts` > 0) issues a new password for the account its first attempt made;
 * any other existing account is left alone and the message is skipped.
 */
export async function provisionWelcomeAccount(m: { id: string; leadId: string | null; toEmail: string; campaignId: string | null }, audience: WelcomeAudience, actorId: string, priorAttempts: number): Promise<{ skip: string } | { vars: Variables }> {
  const email = m.toEmail.trim().toLowerCase();
  const policy = await getSetting('security.policy');
  const password = generateTempPassword(Math.max(14, policy.passwordMinLength));
  const passwordHash = await hashPassword(password);
  const expires = new Date(Date.now() + audience.passwordExpiryDays * 86400_000);
  const vars = (workspaceName: string): Variables => ({
    username: email,
    temporaryPassword: password,
    loginUrl: `${process.env.APP_URL ?? 'http://localhost:3000'}/login`,
    passwordExpiresOn: new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: audience.timezone }).format(expires),
    workspaceName,
  });
  const actor = { user: { id: actorId, email: '', name: 'welcome emails', mfaEnabled: false } };

  const out = await withPlatform(async (tx): Promise<{ skip: string } | { vars: Variables; created?: { org: { id: string; name: string; code: string; industry: string | null }; user: { name: string; email: string } } }> => {
    const existing = await tx.user.findUnique({ where: { email }, include: { membership: { include: { organization: { select: { name: true } } } } } });
    if (existing) {
      const ownPending = priorAttempts > 0 && existing.mustChangePassword && !existing.lastLoginAt && existing.membership?.organization;
      if (!ownPending) return { skip: 'Already has an account' };
      await tx.user.update({ where: { id: existing.id }, data: { passwordHash, tempPasswordExpiresAt: expires, failedLoginCount: 0, lockedUntil: null } });
      return { vars: vars(existing.membership!.organization!.name) };
    }
    const lead = m.leadId ? await tx.lead.findUnique({ where: { id: m.leadId }, select: { fullName: true, company: true, industry: true, phone: true } }) : null;
    const fullName = lead?.fullName?.trim();
    const name = fullName && fullName.length >= 2 ? fullName.slice(0, 120) : email.split('@')[0].slice(0, 120).padEnd(2, '-');
    const company = lead?.company?.trim();
    const workspaceName = (company && company.length >= 2 ? company : `${name}’s workspace`).slice(0, 120);
    const org = await insertOrganization(tx, actorId, { name: workspaceName, contactEmail: email, contactPhone: lead?.phone ?? null, industry: lead?.industry ?? null });
    const role = await tx.role.findFirstOrThrow({ where: { key: 'client_owner', organizationId: null } });
    const user = await tx.user.create({
      data: { email, name, passwordHash, status: 'ACTIVE', mustChangePassword: true, tempPasswordExpiresAt: expires, passwordChangedAt: new Date(), phone: lead?.phone ?? null },
    });
    await tx.membership.create({ data: { userId: user.id, organizationId: org.id, roleId: role.id } });
    await audit(tx, actor, {
      action: 'org.created', targetType: 'organization', targetId: org.id, organizationId: org.id,
      after: { name: workspaceName, code: org.code, slug: org.slug }, metadata: { via: 'welcome_email', leadId: m.leadId },
    });
    await audit(tx, actor, {
      action: 'user.welcome_account_created', targetType: 'user', targetId: user.id, organizationId: org.id,
      metadata: { leadId: m.leadId, campaignId: m.campaignId, messageId: m.id, role: role.key, tempPasswordExpiresAt: expires },
    });
    return { vars: vars(workspaceName), created: { org: { id: org.id, name: org.name, code: org.code, industry: org.industry }, user: { name, email } } };
  }, { timeout: 30_000 });
  if ('created' in out && out.created) {
    const { emitEmailEvent } = await import('./endpoints');
    const organization = { ...out.created.org, contactEmail: email };
    await emitEmailEvent('organization.created', { organization, owner: out.created.user, via: 'welcome_email' }, organization.id);
    await emitEmailEvent('account.welcome_created', { user: out.created.user, organization, lead: { id: m.leadId } }, organization.id);
  }
  return 'skip' in out ? out : { vars: out.vars };
}

// ── Admin views ────────────────────────────────────────────────────

/** Everything the Welcome emails tab needs: settings, platform senders, known lead sources and recent imports. */
export async function welcomeOverview(ctx: AuthContext) {
  assertCan(ctx, 'orgs.create');
  const [settings, senders, sources, imports] = await Promise.all([
    getWelcomeSettings(),
    withPlatform((tx) => tx.smtpAccount.findMany({ where: { organizationId: null, deletedAt: null }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }], select: { id: true, label: true, fromName: true, fromEmail: true, status: true, isDefault: true, perMinuteLimit: true } })),
    withPlatform((tx) => tx.lead.groupBy({ by: ['source'], where: { source: { not: null }, archivedAt: null }, _count: { _all: true }, orderBy: { _count: { source: 'desc' } }, take: 100 })),
    withPlatform((tx) => tx.importBatch.findMany({ where: { status: 'COMPLETED' }, orderBy: { completedAt: 'desc' }, take: 15, select: { id: true, code: true, fileName: true, source: true, insertedCount: true, completedAt: true } })),
  ]);
  const campaigns = imports.length
    ? await withPlatform((tx) => tx.emailCampaign.findMany({
      where: { organizationId: null, OR: imports.map((i) => ({ audience: { path: ['importId'], equals: i.id } })) },
      select: { id: true, status: true, sentCount: true, failedCount: true, skippedCount: true, totalRecipients: true, scheduledFor: true, audience: true },
    }))
    : [];
  const byImport = new Map(campaigns.map((c) => [(c.audience as { importId: string }).importId, c]));
  return {
    settings,
    senders,
    sources: sources.map((s) => ({ source: s.source!, leads: s._count._all })),
    imports: imports.map((i) => {
      const c = byImport.get(i.id);
      return { ...i, campaign: c ? { id: c.id, status: c.status, sentCount: c.sentCount, failedCount: c.failedCount, skippedCount: c.skippedCount, totalRecipients: c.totalRecipients, scheduledFor: c.scheduledFor } : null };
    }),
  };
}

export async function sendWelcomeForImport(ctx: AuthContext, importId: string) {
  assertCan(ctx, 'orgs.create');
  return queueWelcomeForImport(importId, { manual: { ctx } });
}
