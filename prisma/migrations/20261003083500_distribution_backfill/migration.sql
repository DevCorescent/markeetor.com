-- Backfill per-lead distribution counters from assignment history.
-- lead_assignments has FORCE ROW LEVEL SECURITY, so the platform bypass must be enabled for this statement.
SELECT set_config('app.bypass_rls', 'on', false);

UPDATE "leads" AS l
SET "distributionCount" = a.n, "lastDistributedAt" = a.last
FROM (SELECT "leadId", count(*)::int AS n, max("assignedAt") AS last FROM "lead_assignments" GROUP BY "leadId") AS a
WHERE l.id = a."leadId";

SELECT set_config('app.bypass_rls', 'off', false);
