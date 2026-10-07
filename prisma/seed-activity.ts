/**
 * Development-only: allocates the demo leads through the real distribution engine, then backfills a
 * realistic, deterministic CRM history (contacts, stages, deals, tasks, notes) so dashboards have
 * meaningful demo data. All of it is clearly demo data — never run in production.
 */
import { Prisma, PrismaClient, type ClientLeadStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { createDistribution, executeBatch } from '../src/server/services/distribution';

type Tx = Prisma.TransactionClient;

export async function seedActivity(prisma: PrismaClient, ownerId: string) {
  let s = 0x51ed2701;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
  const platform = <T,>(fn: (tx: Tx) => Promise<T>) =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      return fn(tx);
    }, { timeout: 300_000 });

  const orgs = await prisma.organization.findMany({ where: { settings: { path: ['demo'], equals: true } }, select: { id: true } });
  if (!orgs.length) return;

  console.log('▸ allocating demo leads via the distribution engine (GEOGRAPHY strategy)');
  const { batch } = await createDistribution(null, {
    selection: { mode: 'filter', filter: { conditions: [{ field: 'quality', op: 'in', value: ['VALID'] }, { field: 'allocationStatus', op: 'in', value: ['UNALLOCATED'] }] }, excludeIds: [] },
    strategy: 'GEOGRAPHY',
    targets: orgs.map((o) => ({ organizationId: o.id })),
    respectQuotas: true,
    includeInvalid: false,
    idempotencyKey: `seed-${randomUUID()}`,
    confirmLarge: true,
    note: 'Initial demo allocation (seed)',
  }, { mode: 'MANUAL', initiatorId: ownerId });
  await executeBatch(batch.id);

  console.log('▸ backfilling demo CRM activity');
  const now = Date.now();
  const DAY = 86400_000;
  for (const org of orgs) {
    await platform(async (tx) => {
      const members = await tx.membership.findMany({ where: { organizationId: org.id, role: { key: { in: ['sales_executive', 'sales_manager'] } } }, select: { userId: true } });
      const reps = members.map((m) => m.userId);
      const stages = await tx.pipelineStage.findMany({ where: { organizationId: org.id }, orderBy: { position: 'asc' } });
      const byName = (n: string) => stages.find((x) => x.name === n)!;
      // Only backfill projections that have no recorded work yet.
      const leads = await tx.clientLead.findMany({ where: { organizationId: org.id, revokedAt: null, firstContactAt: null, comms: { none: {} }, status: 'NEW' } });
      const comms: Prisma.CommunicationLogCreateManyInput[] = [];
      const acts: Prisma.ActivityCreateManyInput[] = [];
      const tasks: Prisma.TaskCreateManyInput[] = [];
      const notes: Prisma.NoteCreateManyInput[] = [];
      const hist: Prisma.StageHistoryCreateManyInput[] = [];
      for (const l of leads) {
        const created = new Date(now - Math.floor(rand() * 60 * DAY) - 3600_000);
        const r = rand();
        const status: ClientLeadStatus = r < 0.26 ? 'NEW' : r < 0.56 ? 'CONTACTED' : r < 0.7 ? 'QUALIFIED' : r < 0.78 ? 'NEGOTIATION' : r < 0.9 ? 'CONVERTED' : 'LOST';
        const owner = rand() < 0.85 ? pick(reps) : null;
        const stage = byName({ NEW: 'New', CONTACTED: 'Contacted', QUALIFIED: rand() < 0.5 ? 'Qualified' : 'Proposal', NEGOTIATION: 'Negotiation', CONVERTED: 'Won', LOST: 'Lost' }[status]);
        const age = now - created.getTime();
        const firstContact = status === 'NEW' ? null : new Date(created.getTime() + Math.min(age * 0.3, (1 + rand() * 70) * 3600_000));
        const last = firstContact ? new Date(firstContact.getTime() + rand() * (now - firstContact.getTime())) : null;
        const closed = status === 'CONVERTED' || status === 'LOST' ? new Date((last ?? created).getTime()) : null;
        const value = ['QUALIFIED', 'NEGOTIATION', 'CONVERTED'].includes(status) || (status === 'LOST' && rand() < 0.5) ? Math.round((2 + rand() * 78) * 1000) : null;
        const open = status !== 'CONVERTED' && status !== 'LOST';
        const followUp = open && status !== 'NEW' && rand() < 0.55 ? new Date(now + (rand() * 10 - 3) * DAY) : null;
        await tx.clientLead.update({
          where: { id: l.id },
          data: {
            createdAt: created, ownerId: owner, status, stageId: stage.id, stageEnteredAt: last ?? created, firstContactAt: firstContact, lastActivityAt: last ?? created,
            dealValue: value, probability: stage.probability, convertedAt: status === 'CONVERTED' ? closed : null, lostAt: status === 'LOST' ? closed : null,
            lostReason: status === 'LOST' ? pick(['No budget', 'Chose a competitor', 'Unresponsive', 'Bad timing', 'Not a fit']) : null,
            nextFollowUpAt: followUp, expectedCloseDate: open && value ? new Date(now + rand() * 45 * DAY) : null,
          },
        });
        await tx.leadAssignment.update({ where: { id: l.assignmentId }, data: { assignedAt: created } });
        await tx.lead.update({ where: { id: l.leadId }, data: { clientStatus: status, lastActivityAt: last ?? created, nextFollowUpAt: followUp } });
        await tx.activity.updateMany({ where: { leadId: l.leadId, type: 'LEAD_ASSIGNED' }, data: { createdAt: created } });
        if (owner) acts.push({ organizationId: org.id, clientLeadId: l.id, leadId: l.leadId, actorId: owner, type: 'OWNER_CHANGED', summary: 'Assigned to owner', createdAt: new Date(created.getTime() + 600_000) });
        if (firstContact && owner) {
          const attempts = 1 + Math.floor(rand() * 4);
          for (let i = 0; i < attempts; i++) {
            const at = new Date(firstContact.getTime() + (i / attempts) * ((last ?? firstContact).getTime() - firstContact.getTime()));
            const channel = pick(['CALL', 'CALL', 'EMAIL', 'WHATSAPP', 'MEETING'] as const);
            const outcome = channel === 'CALL' ? pick(['CONNECTED', 'NO_ANSWER', 'VOICEMAIL', 'CONNECTED']) : channel === 'MEETING' ? 'HELD' : pick(['SENT', 'REPLIED']);
            comms.push({ organizationId: org.id, clientLeadId: l.id, userId: owner, channel, direction: 'OUTBOUND', outcome, durationSec: channel === 'CALL' && outcome === 'CONNECTED' ? Math.round(60 + rand() * 900) : null, occurredAt: at, createdAt: at, verification: 'SELF_REPORTED', body: outcome === 'CONNECTED' ? pick(['Discussed requirements, sending proposal.', 'Interested; wants pricing for Q4.', 'Asked to call back next week.', 'Decision maker loops in finance.']) : null });
            acts.push({ organizationId: org.id, clientLeadId: l.id, leadId: l.leadId, actorId: owner, type: 'CONTACT_LOGGED', verification: 'SELF_REPORTED', summary: `Outbound ${channel.toLowerCase()} — ${outcome.toLowerCase().replace('_', ' ')}`, createdAt: at });
          }
        }
        if (stage.position > 0) {
          hist.push({ organizationId: org.id, clientLeadId: l.id, fromStageId: stages[0].id, toStageId: stage.id, changedById: owner, createdAt: last ?? created, durationMs: BigInt(Math.max(0, (last ?? created).getTime() - created.getTime())) });
          acts.push({ organizationId: org.id, clientLeadId: l.id, leadId: l.leadId, actorId: owner, type: status === 'CONVERTED' ? 'LEAD_CONVERTED' : status === 'LOST' ? 'LEAD_LOST' : 'STAGE_CHANGED', summary: `Moved to ${stage.name}`, createdAt: last ?? created });
        }
        if (owner && rand() < 0.3) notes.push({ organizationId: org.id, clientLeadId: l.id, authorId: owner, body: pick(['Prefers WhatsApp over calls.', 'Budget approval expected end of month.', 'Competitor quote received — follow up on differentiators.', 'Asked for case studies in their industry.']), createdAt: last ?? created });
        if (owner && open && rand() < 0.6) {
          const due = followUp ?? new Date(now + (rand() * 8 - 3) * DAY);
          const done = rand() < 0.25;
          tasks.push({ organizationId: org.id, clientLeadId: l.id, title: `${pick(['Call', 'Follow up with', 'Send proposal to', 'Book meeting with'])} ${l.fullName}`, type: pick(['CALL', 'FOLLOW_UP', 'EMAIL', 'MEETING'] as const), priority: pick(['LOW', 'MEDIUM', 'MEDIUM', 'HIGH'] as const), status: done ? 'DONE' : 'OPEN', dueAt: due, assigneeId: owner, createdById: owner, completedAt: done ? due : null, completedById: done ? owner : null, createdAt: created });
        }
      }
      await tx.communicationLog.createMany({ data: comms });
      await tx.activity.createMany({ data: acts });
      await tx.task.createMany({ data: tasks });
      await tx.note.createMany({ data: notes });
      await tx.stageHistory.createMany({ data: hist });
    });
  }

  console.log('▸ default workflows (First-contact SLA in test mode)');
  await platform(async (tx) => {
    if (await tx.workflowDefinition.count()) return;
    await tx.workflowDefinition.createMany({
      data: [
        {
          name: 'First-contact SLA', description: 'Allocated lead with no contact attempt within 24h: notify the owner; if still untouched after another 24h, alert managers and flag for platform review.',
          trigger: 'LEAD_NO_CONTACT', conditions: { hours: 24 }, actions: [{ type: 'NOTIFY_OWNER' }, { type: 'DELAY', hours: 24 }, { type: 'NOTIFY_MANAGERS' }, { type: 'NOTIFY_PLATFORM' }, { type: 'FLAG_STALE' }],
          enabled: true, testMode: true, createdById: ownerId,
        },
        {
          name: 'Overdue task escalation', description: 'Tasks overdue by more than 24 hours are escalated to managers.',
          trigger: 'TASK_OVERDUE', conditions: { hours: 24 }, actions: [{ type: 'ESCALATE_TASK' }], enabled: false, testMode: false, createdById: ownerId,
        },
        {
          name: 'Stagnant deal nudge', description: 'Deals exceeding their stage’s expected duration get a follow-up task.',
          trigger: 'STAGE_STAGNANT', conditions: {}, actions: [{ type: 'CREATE_TASK', title: 'Re-engage stagnant deal', dueInHours: 24 }, { type: 'SET_PRIORITY', priority: 'HIGH' }], enabled: false, testMode: true, createdById: ownerId,
        },
      ],
    });
  });
}
