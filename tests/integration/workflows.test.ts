import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SMTPServer } from 'smtp-server';
import { PRESETS } from '@/lib/email/presets';
import { withPlatform, withTenant } from '@/server/db';
import { graphSchema, legacyToGraph, previewWorkflow, runAutomationScan, upsertWorkflow, type Graph } from '@/server/services/automation';
import { createDistribution, executeBatch } from '@/server/services/distribution';
import { designSchema, runCampaign, saveEmailTemplate, saveSmtpAccount } from '@/server/services/email';
import { ctxFor, ensureRoles, makeLeads, makeOrg, makeUser } from '../helpers';

let owner: { id: string };

beforeAll(async () => {
  await ensureRoles();
  owner = await makeUser('platform_owner', null);
});

/** Allocates fresh leads (with the given scores) to a new workspace and returns the org + client leads. */
async function workspaceWithLeads(scores: number[]) {
  const org = await makeOrg();
  const ids: string[] = [];
  for (const score of scores) ids.push(...(await makeLeads(1, { score })));
  const { batch } = await createDistribution(await ctxFor(owner.id), { selection: { mode: 'ids', ids }, strategy: 'EQUAL', targets: [{ organizationId: org.id }], respectQuotas: true, includeInvalid: false, idempotencyKey: `wf-${org.id}`, confirmLarge: true });
  await executeBatch(batch.id);
  const leads = await withTenant(org.id, (tx) => tx.clientLead.findMany({ where: { organizationId: org.id }, orderBy: { score: 'desc' } }));
  return { org, leads };
}

const tagsOf = (orgId: string, clientLeadId: string) =>
  withTenant(orgId, async (tx) => (await tx.clientLeadTag.findMany({ where: { clientLeadId }, include: { tag: true } })).map((t) => t.tag.name).sort());

const base = { enabled: true, testMode: false, maxAttempts: 3 };

describe('workflow graph validation', () => {
  const trigger = { id: 't', type: 'trigger' as const, position: { x: 0, y: 0 }, data: { trigger: 'LEAD_ARRIVED' as const } };
  const tag = (id: string) => ({ id, type: 'action' as const, position: { x: 0, y: 0 }, data: { type: 'ADD_TAG' as const, tag: id } });

  it('rejects loops, double outputs, a second trigger and wrong branch handles', () => {
    const loop = graphSchema.safeParse({ nodes: [trigger, tag('a'), tag('b')], edges: [{ id: '1', source: 't', target: 'a' }, { id: '2', source: 'a', target: 'b' }, { id: '3', source: 'b', target: 'a' }] });
    expect(loop.success).toBe(false);
    expect(JSON.stringify(loop.error?.issues)).toMatch(/loop/);
    const twoOut = graphSchema.safeParse({ nodes: [trigger, tag('a'), tag('b')], edges: [{ id: '1', source: 't', target: 'a' }, { id: '2', source: 't', target: 'b' }] });
    expect(JSON.stringify(twoOut.error?.issues)).toMatch(/more than one/);
    const twoTriggers = graphSchema.safeParse({ nodes: [trigger, { ...trigger, id: 't2' }, tag('a')], edges: [{ id: '1', source: 't', target: 'a' }] });
    expect(JSON.stringify(twoTriggers.error?.issues)).toMatch(/exactly one/);
    const badHandle = graphSchema.safeParse({ nodes: [trigger, { id: 'c', type: 'condition', position: { x: 0, y: 0 }, data: { field: 'HAS_EMAIL', op: 'is_true' } }, tag('a')], edges: [{ id: '1', source: 't', target: 'c' }, { id: '2', source: 'c', target: 'a', sourceHandle: 'next' }] });
    expect(JSON.stringify(badHandle.error?.issues)).toMatch(/wrong output/);
    const intoTrigger = graphSchema.safeParse({ nodes: [trigger, tag('a')], edges: [{ id: '1', source: 't', target: 'a' }, { id: '2', source: 'a', target: 't' }] });
    expect(intoTrigger.success).toBe(false);
  });

  it('converts pre-canvas linear workflows into an equivalent graph', () => {
    const g = legacyToGraph('LEAD_NO_CONTACT', { hours: 12 }, [{ type: 'NOTIFY_OWNER' }, { type: 'DELAY', hours: 2 }, { type: 'FLAG_STALE' }]);
    expect(graphSchema.safeParse(g).success).toBe(true);
    expect(g.nodes.map((n) => n.type)).toEqual(['trigger', 'action', 'delay', 'action']);
    expect(g.edges.map((e) => `${e.source}>${e.target}`)).toEqual(['trigger>a0', 'a0>a1', 'a1>a2']);
  });
});

describe('workflow engine', () => {
  it('follows Yes/No branches on live data, pauses at waits and resumes at the right step', async () => {
    const { org, leads } = await workspaceWithLeads([90, 10]);
    const [hot, cold] = leads;
    const graph: Graph = {
      nodes: [
        { id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { trigger: 'LEAD_ARRIVED', hours: 1, organizationIds: [org.id] } },
        { id: 'c', type: 'condition', position: { x: 0, y: 150 }, data: { field: 'SCORE', op: 'gte', value: 50 } },
        { id: 'hot', type: 'action', position: { x: -150, y: 300 }, data: { type: 'ADD_TAG', tag: 'hot' } },
        { id: 'w', type: 'delay', position: { x: -150, y: 450 }, data: { hours: 1 } },
        { id: 'urgent', type: 'action', position: { x: -150, y: 600 }, data: { type: 'SET_PRIORITY', priority: 'URGENT' } },
        { id: 'cold', type: 'action', position: { x: 150, y: 300 }, data: { type: 'ADD_TAG', tag: 'cold' } },
        { id: 'n', type: 'note', position: { x: 400, y: 0 }, data: { text: 'Explains the flow' } },
      ],
      edges: [
        { id: '1', source: 't', target: 'c', sourceHandle: 'next' },
        { id: '2', source: 'c', target: 'hot', sourceHandle: 'yes' },
        { id: '3', source: 'hot', target: 'w', sourceHandle: 'next' },
        { id: '4', source: 'w', target: 'urgent', sourceHandle: 'next' },
        { id: '5', source: 'c', target: 'cold', sourceHandle: 'no' },
      ],
    };
    const ctx = await ctxFor(owner.id);

    // Dry run evaluates conditions for real but changes nothing.
    const dry = await previewWorkflow({ name: 'Branches', graph, ...base });
    expect(dry.matches).toBe(2);
    expect(dry.sample.find((s) => s.path.includes('hot'))?.log.join(' ')).toMatch(/would tag “hot”/);
    expect(await tagsOf(org.id, hot.id)).toEqual([]);

    const wf = await upsertWorkflow(ctx, null, { name: 'Branches', graph, ...base });
    expect(wf.trigger).toBe('LEAD_ARRIVED');
    await runAutomationScan();
    expect(await tagsOf(org.id, hot.id)).toEqual(['hot']);
    expect(await tagsOf(org.id, cold.id)).toEqual(['cold']);

    const execs = await withPlatform((tx) => tx.workflowExecution.findMany({ where: { workflowId: wf.id } }));
    const hotEx = execs.find((e) => e.subjectId === hot.id)!;
    const coldEx = execs.find((e) => e.subjectId === cold.id)!;
    expect(coldEx.status).toBe('SUCCEEDED');
    expect((coldEx.result as { path: string[] }).path).toEqual(['c', 'cold']);
    expect(hotEx.status).toBe('RUNNING');
    expect((hotEx.result as { node: string }).node).toBe('urgent');

    // A second scan does not start duplicates or skip the wait early.
    await runAutomationScan();
    expect(await withPlatform((tx) => tx.workflowExecution.count({ where: { workflowId: wf.id } }))).toBe(2);
    expect((await withTenant(org.id, (tx) => tx.clientLead.findUniqueOrThrow({ where: { id: hot.id } }))).priority).not.toBe('URGENT');

    // Once the wait has elapsed, the run resumes after the wait.
    await withPlatform((tx) => tx.workflowExecution.update({ where: { id: hotEx.id }, data: { result: { ...(hotEx.result as object), resumeAt: new Date(Date.now() - 1000).toISOString() } } }));
    await runAutomationScan();
    const done = await withPlatform((tx) => tx.workflowExecution.findUniqueOrThrow({ where: { id: hotEx.id } }));
    expect(done.status).toBe('SUCCEEDED');
    expect((done.result as { path: string[] }).path).toEqual(['c', 'hot', 'w', 'urgent']);
    expect((await withTenant(org.id, (tx) => tx.clientLead.findUniqueOrThrow({ where: { id: hot.id } }))).priority).toBe('URGENT');
  });

  it('keeps moving boxes from bumping the version, but behaviour changes do', async () => {
    const { org } = await workspaceWithLeads([5]);
    const ctx = await ctxFor(owner.id);
    const graph = legacyToGraph('LEAD_ARRIVED', { organizationIds: [org.id] }, [{ type: 'ADD_TAG', tag: 'x' }]);
    const wf = await upsertWorkflow(ctx, null, { name: 'Versions', graph, ...base, enabled: false });
    const moved = { ...graph, nodes: graph.nodes.map((n) => ({ ...n, position: { x: n.position.x + 300, y: n.position.y } })) };
    expect((await upsertWorkflow(ctx, wf.id, { name: 'Versions', graph: moved, ...base, enabled: false })).version).toBe(1);
    const changed = { ...moved, nodes: moved.nodes.map((n) => (n.type === 'action' ? { ...n, data: { type: 'ADD_TAG' as const, tag: 'y' } } : n)) };
    expect((await upsertWorkflow(ctx, wf.id, { name: 'Versions', graph: changed, ...base, enabled: false })).version).toBe(2);
  });

  it('runs legacy linear workflows and resumes their in-flight executions at the right step', async () => {
    const { org, leads } = await workspaceWithLeads([5]);
    const wf = await withPlatform((tx) => tx.workflowDefinition.create({
      data: { name: 'Legacy', trigger: 'LEAD_ARRIVED', conditions: { organizationIds: [org.id] }, actions: [{ type: 'ADD_TAG', tag: 'first' }, { type: 'DELAY', hours: 1 }, { type: 'ADD_TAG', tag: 'second' }], enabled: true, testMode: false, createdById: owner.id },
    }));
    // An execution paused by the old engine (linear cursor at step 2, wait elapsed).
    await withPlatform((tx) => tx.workflowExecution.create({
      data: { workflowId: wf.id, version: 1, subjectType: 'client_lead', subjectId: leads[0].id, dedupeKey: `${wf.id}:v1:${leads[0].id}:${leads[0].assignmentId}`, status: 'RUNNING', attempts: 1, result: { step: 2, resumeAt: new Date(Date.now() - 1000).toISOString(), log: ['waiting 1h'] } },
    }));
    await runAutomationScan();
    expect(await tagsOf(org.id, leads[0].id)).toEqual(['second']);
    await withPlatform((tx) => tx.workflowDefinition.update({ where: { id: wf.id }, data: { enabled: false } }));
  });

  it('test mode records what would happen without changing anything', async () => {
    const { org, leads } = await workspaceWithLeads([5]);
    const wf = await upsertWorkflow(await ctxFor(owner.id), null, { name: 'Dry', graph: legacyToGraph('LEAD_ARRIVED', { organizationIds: [org.id] }, [{ type: 'ADD_TAG', tag: 'never' }]), ...base, testMode: true });
    await runAutomationScan();
    expect(await tagsOf(org.id, leads[0].id)).toEqual([]);
    const ex = await withPlatform((tx) => tx.workflowExecution.findFirstOrThrow({ where: { workflowId: wf.id } }));
    expect(ex.testMode).toBe(true);
    expect((ex.result as { log: string[] }).log).toContain('would tag “never”');
  });
});

describe('workflow email action', () => {
  const received: { to: string; subject: string }[] = [];
  let server: SMTPServer;
  let port = 0;
  beforeAll(async () => {
    server = new SMTPServer({
      authOptional: true, allowInsecureAuth: true, disabledCommands: ['STARTTLS'], logger: false,
      onAuth: (_a, _s, cb) => cb(null, { user: 'test' }),
      onData(stream, session, cb) {
        let raw = '';
        stream.on('data', (c) => (raw += c.toString()));
        stream.on('end', () => { received.push({ to: session.envelope.rcptTo.map((r) => r.address).join(','), subject: /Subject: (.*)/.exec(raw)?.[1] ?? '' }); cb(); });
      },
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.server.address() as { port: number }).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('emails new leads from the workspace sender, groups sends into an automation campaign and skips opted-out leads', async () => {
    process.env.SMTP_ALLOW_PRIVATE_HOSTS = 'true';
    try {
      const { org, leads } = await workspaceWithLeads([5, 4]);
      const clientOwner = await makeUser('client_owner', org.id);
      await saveSmtpAccount(await ctxFor(clientOwner.id), null, { label: 'WS', host: '127.0.0.1', port, secure: false, username: 'u', password: 'p', fromName: 'Sales', fromEmail: 'sales@ws.test', replyTo: null, dailyLimit: 1000, perMinuteLimit: 600, isDefault: true });
      await withTenant(org.id, (tx) => tx.consentRecord.create({ data: { organizationId: org.id, clientLeadId: leads[1].id, channel: 'EMAIL', status: 'OPTED_OUT', recordedById: clientOwner.id } }));
      const ctx = await ctxFor(owner.id);
      const tpl = await saveEmailTemplate(ctx, null, { name: 'Welcome', subject: 'Welcome {{firstName}}', preheader: null, category: null, design: designSchema.parse(PRESETS[0].design()) as never });
      const graph = legacyToGraph('LEAD_ARRIVED', { organizationIds: [org.id] }, [{ type: 'SEND_EMAIL', templateId: tpl.id }]);
      const wf = await upsertWorkflow(ctx, null, { name: 'Welcome mail', graph, ...base });
      received.length = 0;
      await runAutomationScan();

      const campaign = await withPlatform((tx) => tx.emailCampaign.findFirstOrThrow({ where: { organizationId: org.id, name: 'Automation · Welcome mail' } }));
      expect(campaign.totalRecipients).toBe(1);
      await runCampaign(campaign.id);
      expect(received).toHaveLength(1);
      expect(received[0].to).toBe(leads[0].email);
      expect(received[0].subject).toBe('Welcome Lead');

      const logs = await withPlatform((tx) => tx.workflowExecution.findMany({ where: { workflowId: wf.id } }));
      expect(logs.map((l) => (l.result as { log: string[] }).log.join()).sort()).toEqual(['queued email “Welcome”', 'skipped (opted out of email)'].sort());
    } finally {
      delete process.env.SMTP_ALLOW_PRIVATE_HOSTS;
    }
  });
});
