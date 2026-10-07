import type { AlertSeverity, Prisma } from '@prisma/client';
import { prisma } from '../db';
import { logger } from '../logger';
import { bumpCounter } from '../ratelimit';
import { getSetting } from '../settings';
import { notifyPermission } from '../services/notifications';

export type AlertInput = {
  type: string;
  severity: AlertSeverity;
  title: string;
  details?: Record<string, unknown>;
  userId?: string | null;
  organizationId?: string | null;
  ip?: string | null;
  /** Alerts sharing a dedupe key are raised once. Include a time bucket to re-alert periodically. */
  dedupeKey?: string;
};

export async function raiseAlert(input: AlertInput) {
  try {
    const created = await prisma.securityAlert.create({
      data: {
        type: input.type,
        severity: input.severity,
        title: input.title,
        details: (input.details ?? {}) as Prisma.InputJsonValue,
        userId: input.userId ?? null,
        organizationId: input.organizationId ?? null,
        ip: input.ip ?? null,
        dedupeKey: input.dedupeKey ?? null,
      },
    });
    if (input.severity === 'HIGH' || input.severity === 'CRITICAL') {
      await notifyPermission('security.read', null, {
        type: 'SECURITY_ALERT',
        title: `${input.severity} security alert: ${input.title}`,
        link: `/admin/security/alerts/${created.id}`,
        dedupeKey: `alert:${created.id}`,
      });
    }
    return created;
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') return null; // deduplicated
    logger.error({ err, type: input.type }, 'failed to raise security alert');
    return null;
  }
}

const hourBucket = () => new Date().toISOString().slice(0, 13);

export async function onLoginFailure(email: string, ip: string | null) {
  const perIp = ip ? await bumpCounter(`loginfail:ip:${ip}`, 900) : 0;
  const perEmail = await bumpCounter(`loginfail:email:${email}`, 900);
  if (perIp >= 10) {
    await raiseAlert({
      type: 'FAILED_LOGIN_BURST', severity: 'HIGH', ip,
      title: `Repeated failed logins from ${ip}`,
      details: { attemptsIn15m: perIp, lastEmail: email },
      dedupeKey: `failburst:${ip}:${hourBucket()}`,
    });
  } else if (perEmail >= 8) {
    await raiseAlert({
      type: 'FAILED_LOGIN_BURST', severity: 'MEDIUM', ip,
      title: `Repeated failed logins for ${email}`,
      details: { attemptsIn15m: perEmail },
      dedupeKey: `failburst-email:${email}:${hourBucket()}`,
    });
  }
}

export async function onForbidden(userId: string, organizationId: string | null, ip: string | null, path: string) {
  const policy = await getSetting('security.policy');
  const n = await bumpCounter(`forbidden:${userId}`, 600);
  if (n >= policy.forbiddenBurstThreshold) {
    await raiseAlert({
      type: 'REPEATED_UNAUTHORIZED', severity: 'HIGH', userId, organizationId, ip,
      title: 'Repeated unauthorized requests',
      details: { countIn10m: n, lastPath: path },
      dedupeKey: `forbidden:${userId}:${hourBucket()}`,
    });
  }
}

export async function onLeadAccess(userId: string, organizationId: string | null, ip: string | null, kind: 'view' | 'reveal') {
  const policy = await getSetting('security.policy');
  const n = await bumpCounter(`leadaccess:${kind}:${userId}`, 3600);
  const threshold = kind === 'view' ? policy.leadViewsPerHourAlert : Math.ceil(policy.revealsPerHour * 0.8);
  if (n >= threshold) {
    await raiseAlert({
      type: 'UNUSUAL_LEAD_ACCESS', severity: kind === 'reveal' ? 'HIGH' : 'MEDIUM', userId, organizationId, ip,
      title: kind === 'reveal' ? 'Unusually high volume of contact reveals' : 'Unusually high lead view volume',
      details: { countThisHour: n, threshold },
      dedupeKey: `leadaccess:${kind}:${userId}:${hourBucket()}`,
    });
  }
}

export async function onPrivilegeChange(details: { actorId: string; targetUserId: string; from?: string; to: string; organizationId?: string | null }) {
  await raiseAlert({
    type: 'PRIVILEGE_CHANGE', severity: 'MEDIUM', userId: details.targetUserId, organizationId: details.organizationId ?? null,
    title: `Role changed${details.from ? ` from ${details.from}` : ''} to ${details.to}`,
    details,
  });
}
