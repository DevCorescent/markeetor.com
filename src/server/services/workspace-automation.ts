import { createHmac, randomBytes } from 'node:crypto';
import https from 'node:https';
import type { Prisma } from '@prisma/client';
import { DEFAULT_WORKSPACE_AUTOMATION, workspaceAutomationSchema, type WorkspaceAutomation } from '@/lib/growth';
import { audit } from '../audit';
import { can, type AuthContext } from '../auth/context';
import { withPlatform, withTenant, type Tx } from '../db';
import { safeLookup, validateUrl } from '../enrichment/fetch';
import { AppError, notFound } from '../errors';
import { logger } from '../logger';
import { incr } from '../kv';

/**
 * Workspace automation (Settings → Automation), stored on the organization's settings:
 *  - auto-assignment of newly delivered leads (round-robin or rules by industry / region / source);
 *  - spending limits for members without workspace-admin rights;
 *  - signed webhooks (HMAC-SHA256) for integrations such as Zapier, Make or an in-house CRM.
 */

export function automationOf(settings: unknown): WorkspaceAutomation {
  const raw = (settings as { automation?: unknown } | null)?.automation;
  const parsed = workspaceAutomationSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : DEFAULT_WORKSPACE_AUTOMATION;
}

export async function getAutomation(orgId: string) {
  const o = await withPlatform((tx) => tx.organization.findUnique({ where: { id: orgId }, select: { settings: true } }));
  if (!o) throw notFound('Workspace');
  return automationOf(o.settings);
}

export async function saveAutomation(ctx: AuthContext, input: WorkspaceAutomation) {
  const orgId = ctx.orgId!;
  const value = workspaceAutomationSchema.parse(input);
  for (const w of value.webhooks) {
    try { validateUrl(w.url); } catch { throw new AppError('VALIDATION_FAILED', `Webhook URL is not allowed: ${w.url}`); }
  }
  return withPlatform(async (tx) => {
    const members = new Set((await tx.membership.findMany({ where: { organizationId: orgId }, select: { userId: true } })).map((m) => m.userId));
    const bad = [...value.autoAssign.memberIds, ...value.autoAssign.rules.map((r) => r.ownerId)].find((id) => !members.has(id));
    if (bad) throw new AppError('VALIDATION_FAILED', 'Auto-assignment can only use members of this workspace');
    const o = await tx.organization.findUniqueOrThrow({ where: { id: orgId }, select: { settings: true } });
    const before = automationOf(o.settings);
    await tx.organization.update({ where: { id: orgId }, data: { settings: { ...(o.settings as object), automation: value } as Prisma.InputJsonValue } });
    // Secrets never go into the audit trail.
    const redact = (a: WorkspaceAutomation) => ({ ...a, webhooks: a.webhooks.map((w) => ({ ...w, secret: '••••' })) });
    await audit(tx, ctx, { action: 'workspace.automation.updated', targetType: 'organization', targetId: orgId, before: redact(before), after: redact(value) });
    return value;
  });
}

export const newWebhookSecret = () => `whsec_${randomBytes(24).toString('hex')}`;

// ── Auto-assignment ────────────────────────────────────────────────

/** Gives unowned, newly delivered leads an owner according to the workspace's rules. */
export async function autoAssign(orgId: string, clientLeadIds: string[]) {
  if (!clientLeadIds.length) return 0;
  const a = await getAutomation(orgId);
  if (a.autoAssign.mode === 'off') return 0;
  return withTenant(orgId, async (tx) => {
    const members = await tx.membership.findMany({ where: { organizationId: orgId, user: { status: 'ACTIVE' } }, select: { userId: true, role: { select: { permissions: { select: { permissionKey: true } } } } } });
    const canOwn = members.filter((m) => m.role.permissions.some((p) => p.permissionKey === 'crm.leads.read_own' || p.permissionKey === 'crm.leads.read_all')).map((m) => m.userId);
    const pool = a.autoAssign.memberIds.length ? a.autoAssign.memberIds.filter((id) => canOwn.includes(id)) : canOwn;
    const leads = await tx.clientLead.findMany({ where: { id: { in: clientLeadIds }, ownerId: null, revokedAt: null }, select: { id: true, industry: true, state: true, country: true, city: true, source: true }, orderBy: { createdAt: 'asc' } });
    let assigned = 0;
    for (const l of leads) {
      let owner: string | null = null;
      if (a.autoAssign.mode === 'rules') {
        const rule = a.autoAssign.rules.find((r) => {
          const v = (l[r.field] ?? '').toLowerCase();
          return v && r.values.some((x) => x.toLowerCase() === v);
        });
        if (rule && canOwn.includes(rule.ownerId)) owner = rule.ownerId;
      }
      if (!owner && (a.autoAssign.mode === 'round_robin' || a.autoAssign.fallback) && pool.length) {
        const n = await incr(`rr:${orgId}`).catch(() => assigned + 1);
        owner = pool[(n - 1) % pool.length];
      }
      if (!owner) continue;
      await tx.clientLead.update({ where: { id: l.id }, data: { ownerId: owner } });
      await tx.activity.create({ data: { organizationId: orgId, clientLeadId: l.id, type: 'OWNER_CHANGED', verification: 'SYSTEM_VERIFIED', summary: 'Assigned automatically', data: { ownerId: owner, mode: a.autoAssign.mode } } });
      assigned++;
    }
    return assigned;
  });
}

// ── Spending limits ────────────────────────────────────────────────

/** Throws when a member's request would exceed the workspace's limits. Workspace admins are exempt. */
export async function checkSpending(tx: Tx, ctx: AuthContext, req: { credits: number; amountCents: number }) {
  if (!ctx.orgId || can(ctx, 'crm.settings.manage')) return;
  const o = await tx.organization.findUnique({ where: { id: ctx.orgId }, select: { settings: true } });
  const s = automationOf(o?.settings).spending;
  if (s.maxCreditsPerRequest && req.credits > s.maxCreditsPerRequest) throw new AppError('FORBIDDEN', `Your workspace limits requests to ${s.maxCreditsPerRequest.toLocaleString()} credits. Ask a workspace admin to place larger requests.`);
  if (s.maxAmountPerRequest && req.amountCents > s.maxAmountPerRequest * 100) throw new AppError('FORBIDDEN', `Your workspace limits requests to ${s.maxAmountPerRequest.toLocaleString()} per request. Ask a workspace admin to place larger requests.`);
  if (s.monthlyCreditsPerUser && req.credits > 0) {
    const start = new Date(); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
    const used = await tx.leadRequest.aggregate({ where: { organizationId: ctx.orgId, requestedById: ctx.user.id, createdAt: { gte: start }, status: { in: ['PENDING', 'FULFILLED', 'PARTIAL'] } }, _sum: { creditsCharged: true } });
    const total = (used._sum.creditsCharged ?? 0) + req.credits;
    if (total > s.monthlyCreditsPerUser) throw new AppError('FORBIDDEN', `This would take you over your monthly limit of ${s.monthlyCreditsPerUser.toLocaleString()} credits (${(used._sum.creditsCharged ?? 0).toLocaleString()} used). Ask a workspace admin.`);
  }
}

// ── Webhooks ───────────────────────────────────────────────────────

export type WebhookEvent = 'leads.delivered' | 'lead.status_changed' | 'dispute.decided';

/** Records a delivery for every active webhook subscribed to the event and queues it. */
export async function emitWebhook(orgId: string, event: WebhookEvent, data: unknown) {
  const a = await getAutomation(orgId).catch(() => null);
  const hooks = (a?.webhooks ?? []).filter((w) => w.active && w.events.includes(event));
  if (!hooks.length) return 0;
  const { enqueue } = await import('../jobs/queues');
  for (const h of hooks) {
    const payload = { id: `evt_${randomBytes(10).toString('hex')}`, event, createdAt: new Date().toISOString(), organizationId: orgId, data };
    const row = await withPlatform((tx) => tx.webhookDelivery.create({ data: { organizationId: orgId, url: h.url, event, payload: payload as Prisma.InputJsonValue } }));
    await enqueue('automation', 'webhook', { deliveryId: row.id }, { jobId: `wh-${row.id}`, attempts: 5, backoff: { type: 'exponential', delay: 30_000 } }).catch((err) => logger.warn({ err }, 'failed to enqueue webhook'));
  }
  return hooks.length;
}

function post(url: string, body: string, headers: Record<string, string>) {
  const u = validateUrl(url);
  return new Promise<number>((resolve, reject) => {
    const req = https.request(u, { method: 'POST', lookup: safeLookup, timeout: 10_000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body).toString(), 'user-agent': 'LeadsCRM-Webhooks/1.0', ...headers } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('timeout', () => req.destroy(new Error('Timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

/** Worker: delivers one webhook. Signature: `t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. */
export async function deliverWebhook(deliveryId: string) {
  const d = await withPlatform((tx) => tx.webhookDelivery.findUnique({ where: { id: deliveryId } }));
  if (!d || d.status === 'DELIVERED') return;
  const hook = (await getAutomation(d.organizationId)).webhooks.find((w) => w.url === d.url && w.active);
  if (!hook) {
    await withPlatform((tx) => tx.webhookDelivery.update({ where: { id: d.id }, data: { status: 'FAILED', error: 'Webhook removed or disabled' } }));
    return;
  }
  const body = JSON.stringify(d.payload);
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', hook.secret).update(`${t}.${body}`).digest('hex');
  let code = 0;
  let error: string | null = null;
  try {
    code = await post(d.url, body, { 'x-leadscrm-event': d.event, 'x-leadscrm-signature': `t=${t},v1=${sig}`, 'x-leadscrm-delivery': d.id });
    if (code < 200 || code >= 300) error = `HTTP ${code}`;
  } catch (err) {
    error = (err as Error).message.slice(0, 300);
  }
  await withPlatform((tx) => tx.webhookDelivery.update({ where: { id: d.id }, data: { attempts: { increment: 1 }, responseCode: code || null, error, status: error ? 'FAILED' : 'DELIVERED', deliveredAt: error ? null : new Date() } }));
  if (error) throw new Error(`Webhook ${d.id} failed: ${error}`); // the worker retries with backoff
}

export async function listWebhookDeliveries(ctx: AuthContext, page = 1) {
  return withPlatform(async (tx) => {
    const where = { organizationId: ctx.orgId! };
    const [total, rows] = await Promise.all([
      tx.webhookDelivery.count({ where }),
      tx.webhookDelivery.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * 25, take: 25, select: { id: true, url: true, event: true, status: true, attempts: true, responseCode: true, error: true, deliveredAt: true, createdAt: true } }),
    ]);
    return { total, rows };
  });
}

/** Sends a test event to one webhook right away. */
export async function testWebhook(ctx: AuthContext, webhookId: string) {
  const a = await getAutomation(ctx.orgId!);
  const h = a.webhooks.find((w) => w.id === webhookId);
  if (!h) throw notFound('Webhook');
  const row = await withPlatform((tx) => tx.webhookDelivery.create({ data: { organizationId: ctx.orgId!, url: h.url, event: 'test', payload: { id: `evt_test_${Date.now()}`, event: 'test', createdAt: new Date().toISOString(), organizationId: ctx.orgId, data: { message: 'Webhook test from markeetor.com' } } } }));
  await deliverWebhook(row.id).catch(() => null);
  return withPlatform((tx) => tx.webhookDelivery.findUniqueOrThrow({ where: { id: row.id }, select: { status: true, responseCode: true, error: true } }));
}

// ── Delivery hook ──────────────────────────────────────────────────

/** Runs after leads land in a workspace: auto-assignment, then the `leads.delivered` webhook. */
export async function onLeadsDelivered(orgId: string, batchId: string) {
  try {
    // Assignments are platform records, so the lookup runs with platform access (scoped to this workspace).
    const leads = await withPlatform((tx) => tx.clientLead.findMany({
      where: { organizationId: orgId, revokedAt: null, assignment: { batchId } },
      select: { id: true, leadId: true, fullName: true, email: true, phone: true, company: true, jobTitle: true, city: true, state: true, country: true, industry: true, source: true, campaign: true, score: true, createdAt: true },
    }));
    if (!leads.length) return;
    await autoAssign(orgId, leads.map((l) => l.id));
    await emitWebhook(orgId, 'leads.delivered', { count: leads.length, leads: leads.map(({ leadId: _l, ...l }) => l) });
  } catch (err) {
    logger.warn({ err, orgId, batchId }, 'post-delivery automation failed');
  }
}
