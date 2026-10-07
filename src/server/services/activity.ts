import type { ActivityVerification, Prisma } from '@prisma/client';
import type { Tx } from '../db';

/**
 * Canonical lead lifecycle event types. `verification` distinguishes events the system observed
 * directly (assignment, view, reveal, stage change) from activity a user *reported* (a logged call
 * is not proof that a conversation happened).
 */
export const ACTIVITY = {
  LEAD_IMPORTED: 'LEAD_IMPORTED',
  LEAD_CREATED: 'LEAD_CREATED',
  LEAD_ASSIGNED: 'LEAD_ASSIGNED',
  LEAD_REVOKED: 'LEAD_REVOKED',
  LEAD_REASSIGNED: 'LEAD_REASSIGNED',
  LEAD_VIEWED: 'LEAD_VIEWED',
  FIELD_REVEALED: 'FIELD_REVEALED',
  LEAD_EDITED: 'LEAD_EDITED',
  STATUS_CHANGED: 'STATUS_CHANGED',
  STAGE_CHANGED: 'STAGE_CHANGED',
  OWNER_CHANGED: 'OWNER_CHANGED',
  NOTE_ADDED: 'NOTE_ADDED',
  FOLLOW_UP_SCHEDULED: 'FOLLOW_UP_SCHEDULED',
  TASK_CREATED: 'TASK_CREATED',
  TASK_COMPLETED: 'TASK_COMPLETED',
  CONTACT_LOGGED: 'CONTACT_LOGGED',
  CONSENT_CHANGED: 'CONSENT_CHANGED',
  ATTACHMENT_ADDED: 'ATTACHMENT_ADDED',
  ATTACHMENT_VIEWED: 'ATTACHMENT_VIEWED',
  LEAD_CONVERTED: 'LEAD_CONVERTED',
  LEAD_LOST: 'LEAD_LOST',
  LEAD_ARCHIVED: 'LEAD_ARCHIVED',
  LEAD_RESTORED: 'LEAD_RESTORED',
  LEAD_MERGED: 'LEAD_MERGED',
  LEAD_TAGGED: 'LEAD_TAGGED',
  STALE_FLAGGED: 'STALE_FLAGGED',
} as const;
export type ActivityType = (typeof ACTIVITY)[keyof typeof ACTIVITY];

export type ActivityInput = {
  organizationId?: string | null;
  leadId?: string | null;
  clientLeadId?: string | null;
  actorId?: string | null;
  type: ActivityType;
  verification?: ActivityVerification;
  summary: string;
  data?: Record<string, unknown>;
};

export async function recordActivity(tx: Tx, a: ActivityInput) {
  await tx.activity.create({
    data: {
      organizationId: a.organizationId ?? null,
      leadId: a.leadId ?? null,
      clientLeadId: a.clientLeadId ?? null,
      actorId: a.actorId ?? null,
      type: a.type,
      verification: a.verification ?? 'SYSTEM_VERIFIED',
      summary: a.summary.slice(0, 500),
      data: (a.data ?? {}) as Prisma.InputJsonValue,
    },
  });
}

export async function recordActivities(tx: Tx, items: ActivityInput[]) {
  if (!items.length) return;
  await tx.activity.createMany({
    data: items.map((a) => ({
      organizationId: a.organizationId ?? null,
      leadId: a.leadId ?? null,
      clientLeadId: a.clientLeadId ?? null,
      actorId: a.actorId ?? null,
      type: a.type,
      verification: a.verification ?? 'SYSTEM_VERIFIED',
      summary: a.summary.slice(0, 500),
      data: (a.data ?? {}) as Prisma.InputJsonValue,
    })),
  });
}
