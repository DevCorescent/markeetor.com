-- ════════════════════════════════════════════════════════════════════
-- Security & integrity layer that Prisma's schema language can't express.
-- ════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Integrity constraints ────────────────────────────────────────────
-- A lead can be held by at most one organization at a time. This is the
-- last line of defence against duplicate allocation under concurrency.
CREATE UNIQUE INDEX lead_assignments_one_active ON lead_assignments ("leadId") WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX client_leads_one_visible ON client_leads ("organizationId", "leadId") WHERE "revokedAt" IS NULL;

-- Uniqueness for rows whose "organizationId" is NULL (platform-level rows).
CREATE UNIQUE INDEX roles_system_key ON roles (key) WHERE "organizationId" IS NULL;
CREATE UNIQUE INDEX tags_platform_name ON tags (name) WHERE "organizationId" IS NULL;
CREATE UNIQUE INDEX lead_custom_fields_platform_key ON lead_custom_fields (key) WHERE "organizationId" IS NULL;
CREATE UNIQUE INDEX integration_configs_platform_provider ON integration_configs (provider) WHERE "organizationId" IS NULL;

-- Score / probability sanity.
ALTER TABLE leads ADD CONSTRAINT leads_score_range CHECK (score BETWEEN 0 AND 100);
ALTER TABLE client_leads ADD CONSTRAINT client_leads_probability_range CHECK (probability IS NULL OR probability BETWEEN 0 AND 100);
ALTER TABLE client_quotas ADD CONSTRAINT client_quotas_positive CHECK ("maxActiveLeads" >= 0 AND "dailyAllocationLimit" >= 0 AND "monthlyAllocationLimit" >= 0 AND weight >= 0);

-- ── Search ───────────────────────────────────────────────────────────
CREATE INDEX leads_fullname_trgm ON leads USING gin ("fullName" gin_trgm_ops);
CREATE INDEX leads_company_trgm ON leads USING gin (company gin_trgm_ops);
CREATE INDEX leads_email_trgm ON leads USING gin ("emailNormalized" gin_trgm_ops);
CREATE INDEX client_leads_fullname_trgm ON client_leads USING gin ("fullName" gin_trgm_ops);
CREATE INDEX client_leads_company_trgm ON client_leads USING gin (company gin_trgm_ops);

-- ── Tamper-evident, append-only audit log ────────────────────────────
-- Each row's hash = sha256(previous hash || canonical row content). The chain
-- head is a single locked row, so sequence order == chain order.
CREATE TABLE audit_chain_head (
  id        int PRIMARY KEY CHECK (id = 1),
  last_hash text,
  last_seq  bigint NOT NULL DEFAULT 0
);
INSERT INTO audit_chain_head (id, last_hash, last_seq) VALUES (1, NULL, 0);

CREATE FUNCTION audit_canonical(e audit_events) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT concat_ws('|',
    coalesce(e."prevHash", ''), e.id, e.seq::text,
    coalesce(e."actorId", ''), coalesce(e."actorEmail", ''), coalesce(e."actorRole", ''),
    coalesce(e."organizationId", ''), e.action,
    coalesce(e."targetType", ''), coalesce(e."targetId", ''), e.result::text,
    coalesce(e.reason, ''), coalesce(e.before::text, ''), coalesce(e.after::text, ''),
    coalesce(e.metadata::text, ''), coalesce(e."requestId", ''), coalesce(e."sessionId", ''),
    coalesce(e.ip, ''), to_char(e."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS'))
$$;

CREATE FUNCTION audit_events_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  head audit_chain_head%ROWTYPE;
BEGIN
  SELECT * INTO head FROM audit_chain_head WHERE id = 1 FOR UPDATE;
  NEW.seq := head.last_seq + 1;
  NEW."prevHash" := head.last_hash;
  NEW.hash := encode(digest(audit_canonical(NEW), 'sha256'), 'hex');
  UPDATE audit_chain_head SET last_hash = NEW.hash, last_seq = NEW.seq WHERE id = 1;
  RETURN NEW;
END $$;

CREATE TRIGGER audit_events_chain BEFORE INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_chain();

-- Rows can never be edited. Deletion is only possible through the retention
-- purge, which must explicitly opt in inside its own transaction.
CREATE FUNCTION audit_events_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND coalesce(current_setting('app.audit_purge', true), '') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_events is append-only (% blocked)', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_immutable();

-- Walks the chain and returns the first sequence number whose hash does not
-- match (NULL when intact). The oldest remaining row anchors the chain, so
-- retention purges don't register as tampering.
CREATE FUNCTION audit_verify_chain() RETURNS TABLE (checked bigint, first_broken_seq bigint)
LANGUAGE plpgsql AS $$
DECLARE
  r audit_events%ROWTYPE;
  expected_prev text;
  first boolean := true;
  n bigint := 0;
BEGIN
  FOR r IN SELECT * FROM audit_events ORDER BY seq LOOP
    n := n + 1;
    IF NOT first AND r."prevHash" IS DISTINCT FROM expected_prev THEN
      checked := n; first_broken_seq := r.seq; RETURN NEXT; RETURN;
    END IF;
    IF r.hash IS DISTINCT FROM encode(digest(audit_canonical(r), 'sha256'), 'hex') THEN
      checked := n; first_broken_seq := r.seq; RETURN NEXT; RETURN;
    END IF;
    expected_prev := r.hash;
    first := false;
  END LOOP;
  checked := n; first_broken_seq := NULL; RETURN NEXT;
END $$;

-- ── Row-level security ───────────────────────────────────────────────
-- The application sets these per transaction (SET LOCAL semantics):
--   app.org_id     → tenant whose rows are visible
--   app.bypass_rls → 'on' only inside platform-scoped service code
-- This is defence in depth behind the application's own authorization checks.
CREATE FUNCTION app_bypass() RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT coalesce(current_setting('app.bypass_rls', true), '') = 'on' $$;
CREATE FUNCTION app_org() RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.org_id', true), '') $$;

DO $$
DECLARE t text;
BEGIN
  -- Tenant-private tables: visible to the owning tenant or platform code.
  FOREACH t IN ARRAY ARRAY[
    'client_leads', 'client_lead_tags', 'pipelines', 'pipeline_stages', 'stage_history',
    'lead_activities', 'lead_notes', 'lead_attachments', 'tasks', 'communication_logs',
    'communication_templates', 'consent_records', 'teams', 'team_members', 'user_targets',
    'tags', 'lead_custom_fields'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (app_bypass() OR "organizationId" = app_org())
      WITH CHECK (app_bypass() OR "organizationId" = app_org())$p$, t);
  END LOOP;

  -- Platform-only tables: tenants can never read or write them.
  FOREACH t IN ARRAY ARRAY[
    'leads', 'lead_tags', 'lead_assignments', 'assignment_batches', 'assignment_batch_items',
    'imports', 'import_rows', 'import_templates', 'distribution_rules'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY platform_only ON %I USING (app_bypass()) WITH CHECK (app_bypass())', t);
  END LOOP;
END $$;

-- Audit: tenants may append events about themselves and read their own;
-- there is deliberately no UPDATE/DELETE policy.
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_select ON audit_events FOR SELECT
  USING (app_bypass() OR "organizationId" = app_org());
CREATE POLICY audit_insert ON audit_events FOR INSERT
  WITH CHECK (app_bypass() OR "organizationId" IS NOT DISTINCT FROM app_org());
CREATE POLICY audit_purge ON audit_events FOR DELETE
  USING (app_bypass() AND coalesce(current_setting('app.audit_purge', true), '') = 'on');
