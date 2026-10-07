# markeetor.com — Development Guide

Multi-tenant lead distribution and CRM platform. A central platform team imports, validates and
distributes leads; each client organization works its allocated leads in an isolated CRM workspace.

> Status date: 2026-10-03. Everything listed under **Implemented** was built against a real
> PostgreSQL database and exercised either by the automated test suite or manually in a browser.
> Anything not verified is listed under **Known limitations / not implemented**.

---

## 1. Quick start (local, no Docker)

Prerequisites: Node 20.9+ (tested on 26), PostgreSQL 16, Redis 7.

```bash
npm install
# 1) Database roles + databases (run as a Postgres superuser)
APP_DB_PASSWORD=... BACKUP_DB_PASSWORD=... npm run db:setup
# 2) Configuration
cp .env.example .env        # fill DATABASE_URL, TEST_DATABASE_URL, BACKUP_DATABASE_URL, ENCRYPTION_KEY, SESSION_SECRET
# 3) Schema + demo data (development only)
npm run db:migrate
npm run db:seed
# 4) Run (two processes)
npm run dev                 # web on :3000 (this workspace used -p 3100)
npm run worker              # background jobs: imports, distribution, automation, maintenance, email
```

With Docker: `docker compose up -d postgres redis` (creates `leads_app` and `leads_backup` roles via
`scripts/docker-init-db.sh`), then steps 2–4. `docker compose --profile app up` also runs web + worker.

### Demo accounts (development seed only)

All seeded accounts use the reserved `.test` domain and the password in `SEED_PASSWORD`
(see `.env.example`). Seeded organizations are named “(Demo)” and carry `settings.demo = true`;
the command center shows a “demo data” banner in development.

| Account | Role |
|---|---|
| `owner@leadscrm.test` | Platform Owner |
| `admin@leadscrm.test` | Super Admin |
| `ops@leadscrm.test` | Lead Operations Manager |
| `security@leadscrm.test` | Security Administrator |
| `analyst@leadscrm.test` | Analytics Administrator |
| `{owner,admin,manager,rep1,rep2,analyst}@{northwind,apex,summit}.test` | Client Owner / Admin / Sales Manager / Sales Executive ×2 / Read-only Analyst |

The seed relaxes `mfaRequiredForPlatform` to `false` **for local sign-in only**; the code default is `true`.

### Useful scripts

| Script | Purpose |
|---|---|
| `npm test` | Vitest: unit + integration + security tests against `TEST_DATABASE_URL` (rebuilt from migrations each run; refuses any DB not ending in `_test`) |
| `npm run typecheck` / `npm run lint` | TypeScript / ESLint (0 errors; warnings documented in `eslint.config.mjs`) |
| `npm run build` | Production build |
| `npm run openapi` | Regenerates `docs/openapi.json` from the live route definitions |
| `npm run db:backup` / `db:restore` | Logical backup (DB + private storage, checksummed) / verified restore |
| `npm run worker` | Background worker (BullMQ) |

---

## 2. Architecture

```
Next.js 16 (App Router, React 19, Tailwind 4)            ┌──────────── Worker process (tsx) ───────────┐
  ├─ Server components (pages) ─┐                        │ BullMQ queues: imports · distribution ·      │
  ├─ Client components (TanStack Query/Table, Recharts)  │ automation · maintenance · email             │
  └─ REST API  /api/v1/*  ──────┤                        │ repeatables: rules tick 1m, automation 5m,   │
                                ▼                        │ maintenance 1m, purge daily, reports daily   │
                   src/server  (modular service layer)   └──────────────────────────────────────────────┘
   api.ts  route wrapper: auth · CSRF · rate limits · scope/permission checks · zod · errors · denial audit
   auth/   sessions, argon2id, TOTP MFA, API keys, authorization context
   services/  organizations · users · roles · approvals · leads · imports · distribution · crm ·
              attachments · analytics · reports · automation · governance (audit/security/settings)
   db.ts   withPlatform(fn) / withTenant(orgId, fn) — RLS-scoped transactions
                                ▼
           PostgreSQL 16 (Prisma 6)  +  Redis (rate limits, queues, MFA enrollment, heartbeats)
```

**Decision: modular monolith instead of a separate NestJS service.** One deployable for web+API with a
strict `src/server` service layer (no business logic in route files), plus a separate worker process
sharing the same services. It halves operational surface while keeping a clean seam to extract an API
service later. Route handlers are plain `(Request) => Response` functions, so the test suite calls them directly.

### Lead ownership model (master record + tenant projections)

* `leads` — platform-owned **master** record. Contact data, attribution, quality, allocation state.
  Row-level security makes it **invisible to tenant transactions**.
* `lead_assignments` — who holds a lead. A partial unique index (`… WHERE status = 'ACTIVE'`)
  guarantees at most one active holder; revoked/rolled-back/reassigned rows are kept as history.
* `client_leads` — the tenant’s **projection**, created at allocation time. It holds a working copy
  of contact fields (client-editable, never written back to master), read-only attribution, and all
  CRM state. Notes, tasks, communication, attachments, consent and stage history hang off it.

Trade-offs: data is duplicated (projection copy) and master/projection can drift for contact fields —
in exchange tenants can never read master data or other tenants’ history; revoking an allocation just
sets `revokedAt` and the previous tenant’s work stays private when the lead is reassigned (verified by
test). Client progress (status, last activity, follow-up) is synced to the master record server-side
for platform analytics.

---

## 3. Security design

| Control | Implementation |
|---|---|
| Authentication | Opaque 256-bit session tokens (SHA-256 stored), `HttpOnly; SameSite=Lax; Secure` (`__Host-` prefix in prod) cookie, 12 h absolute + 30 min idle (configurable; per-workspace stricter idle) |
| Passwords | argon2id (19 MiB, t=2), policy: length ≥ 12, 3 char classes, common-password and name/email checks; constant-time behaviour for unknown accounts |
| MFA | TOTP (RFC 6238) with AES-256-GCM-encrypted secrets, 10 hashed recovery codes, session token rotated after MFA, platform/workspace “MFA required” enforcement before any data access |
| Step-up | Re-verification (TOTP or password) within 10 min for exports, rollbacks, role changes, overrides, API keys, policy changes |
| Lockout & abuse | Per-account lockout (5 failures → 15 min), per-IP/per-email login rate limits, failed-login burst alerts, generic error messages |
| Authorization | Deny-by-default `route()` wrapper: every route declares scope (PLATFORM/ORGANIZATION) and permissions; 36 granular platform + 25 workspace permissions; roles carry ranks to prevent escalation; overrides limited to permissions the granter holds; privileged roles require a second approver |
| Tenant isolation | Tenant id always comes from the server-side session, never the request. Services add explicit `organizationId` filters **and** run inside `withTenant`, where PostgreSQL RLS (`FORCE ROW LEVEL SECURITY`) hides other tenants and all platform tables. The app role is `NOSUPERUSER NOBYPASSRLS`. Out-of-scope ids return 404 (no enumeration) |
| CSRF | SameSite cookies + mandatory same-origin `Origin`/`Referer` on all cookie-authenticated mutations |
| Input/output | Zod validation on every body/query; whitelisted filter DSL (own-property lookups only); parameterized SQL only; React output encoding; strict CSP, `frame-ancestors 'none'`, nosniff, HSTS (prod) |
| Files | Uploads checked by extension **and** magic bytes (CSV/XLSX; PDF/PNG/JPEG/WebP/text for attachments), size limits, random server-side keys in private storage outside the web root, path-traversal-proof key resolver; XLSX formulas are never evaluated; attachments served inline with a sandbox CSP |
| Formula injection | Every generated CSV cell starting with `= + - @ \t \r` is prefixed with `'` |
| Rate limits | Redis fixed windows: per-user API ceiling, per-route buckets (search, lists, exports, reveals per user and per tenant, uploads) |
| Audit | `audit_events` is append-only (UPDATE/DELETE/TRUNCATE blocked by trigger + no RLS update policy) and SHA-256 hash-chained via a DB trigger; `audit_verify_chain()` detects tampering; retention purge is the only delete path and records itself; secrets are redacted from payloads |
| Monitoring | Alerts: failed-login bursts, lockouts, repeated 403s, unusual view/reveal volume, privilege changes, IP-restriction blocks, job dead-letters, capacity auto-pause |
| Secrets | Env-only (`.env` never committed); MFA secrets encrypted; API keys and tokens stored as hashes; invite/reset links single-use with expiry |

### Data-loss prevention for client workspaces

There is **no export or bulk-download endpoint** in the workspace API. Lists are paginated (≤100/page)
and rate limited; contact fields are masked server-side and only revealed one field at a time through
an audited, rate-limited endpoint (optionally requiring a reason); attachments are viewed inline only;
a per-user watermark (email, IP, time) is overlaid on workspace pages; unusual access raises alerts.

**This is risk reduction, not prevention.** Screenshots, photographs, manual transcription and
copying text a user is allowed to see cannot be prevented by a web application.

---

## 4. Module status

### Implemented and verified

**Platform portal (`/admin`)**
- Command center: real KPIs (lead quality, allocation state, clients by status, users, active sessions,
  conversion, follow-up compliance, first-response time), 4-series trend, client performance table,
  lead aging, sources, security alerts, import/job failures, live system health (DB, Redis, worker
  heartbeat, queue depths, SMTP); date range, client/source/campaign filters, saved filter sets, drill-down links.
- Organizations: create (unique `ORG-XXXXXX` code, default pipeline provisioning, owner invitation),
  profile edit, logo upload (signature-checked raster only), features, security requirements
  (MFA, idle timeout, IP allowlist, reveal reasons, watermark), workflow thresholds, quotas, allocation
  profile (regions/industries/campaigns/score range, weight, auto-distribution opt-in, auto-pause),
  activate/deactivate/suspend/archive/restore with session revocation, users, allocation history, activity.
- Users & roles: invitations (secure links), role changes with escalation guards and approval flow,
  suspend/reactivate/deactivate, unlock, MFA reset, password reset email, session revocation,
  permission overrides (grant/deny, expiry), login history, activity; role matrix + custom roles.
- Approvals: privileged invitations and role grants require a different approver (step-up required).
- Lead repository: server-side pagination/sort/search, multi-condition filter builder (21 fields),
  saved views, column visibility, bulk selection across all filtered results, tag/archive/restore,
  reassign/revoke, send selection to distribution, duplicate review and audited merge, lead detail
  with masked contacts + audited reveal, edit with before/after audit, assignment history, timeline,
  admin export (permission + step-up + reason + audit + formula escaping).
- Import center: CSV/XLSX upload, column mapping with synonym suggestions, custom-field mapping,
  templates, validation rules, email/phone normalization (E.164), in-file and database duplicate
  detection (skip / update / create-flagged), batch tags and attribution, preview with row-level
  errors, typed confirmation for large files, durable chunked processing with progress and
  idempotent resume, rejected-row CSV, retry, controlled rollback (archive inserted, restore updated),
  file and raw-row retention purge.
- Distribution: 10 strategies (equal, custom quantities, round-robin with rotation, weighted, quota,
  capacity, geography, industry, campaign, score), live quota headroom per client, preview (dry run),
  scheduling, typed confirmation for large batches, idempotency keys, lead reservation, per-chunk
  quota row locks with execution-time re-checks, partial-unique-index guarantee, auto-pause at capacity,
  batch records with per-org/per-reason breakdown, cancel, rollback within a window (keeps worked leads
  unless forced by rank ≥ 90), reassignment, revocation, automated rules (manual / scheduled / on-import).
- Guided distribution (`/admin/distribution` → Distribute): 4 steps with Back and a session draft —
  **Pick leads** (live lead table with checkboxes, “select all N matching”, presets such as Ready / Never
  distributed / Returned / High score / Latest import, quick filters for country, industry, source,
  campaign, import, score range, times distributed and “never sent to client”, plus advanced filters) →
  **Choose clients** (cards with web domain, industry, quota room, lifetime volume and, for the actual
  selection, how many leads match each client's regions/industries/campaigns/score and how many it already
  had) → **How to split** (grouped strategies with a suggested one, per-client quantities/weights, options,
  live plan) → **Review** (per-client counts, share and sample leads, reasons for anything not sent).
  By default a lead is **never re-sent to a client that already had it** (`avoidPreviousClients`).
- Tracking: every lead stores `distributionCount` and `lastDistributedAt` (maintained on allocation,
  backfilled by migration). **Lead tracker** shows each lead's journey across clients (domain, industry,
  batch, outcome, client progress, first contact). **Analytics** (7 days – 12 months, by client or client
  domain): distributed/unique/redistributed, return rate, active, contact and conversion rates, time to first
  contact, ready pool, daily trend (top clients), times-distributed histogram, per-client table, by client
  domain, lead source → client matrix, batch performance by strategy and skip reasons.
- Analytics: period comparison, import volume, funnel, time-to-allocate (p50/p90), client performance
  (contact/qualification/conversion rates, first response, follow-up compliance, utilization),
  sources, campaigns, weekly cohorts, custom report builder, saved and scheduled (emailed) reports,
  aggregated CSV export.
- Security center, alert investigation (related audit events and logins, notes, ownership, resolution).
- Audit log: search/filter, event detail with before/after, integrity verification, export.
- Automation: drag-and-drop canvas builder (`/admin/automation/:id`, React Flow). A workflow is a graph —
  one *When* trigger (5 triggers incl. “a new lead arrives”), *If* conditions with Yes/No branches (priority,
  status, owner, email/phone present, score, source, country, tag, weekday, workspace), *Then* actions
  (notify owner/managers/platform, send a template email from the workspace sender, create task, raise
  priority, add tag, escalate task, flag stale), *Wait* steps and sticky notes. Layman UX: recipe gallery,
  “+” buttons on every open output and between steps, drag from the palette with magnetic auto-connect,
  plain-English summary, live problem checks, Tidy auto-layout, undo/redo, ⌘S, autosaved local drafts,
  “Try it” dry run on live data that highlights each lead's route, per-step run counts and run history with
  path highlighting. The graph is validated server-side (one trigger, no loops, one edge per output);
  only behaviour changes create a new version. Pre-canvas linear workflows (and their paused runs) are
  converted transparently. Seeded “First-contact SLA” runs in test mode.
- Settings: security policy, import/distribution policies, audit retention, AI switch (guarded),
  integration status, read-only API keys (scoped, expiring, shown once), dev outbox, API reference.

**Client workspace (`/app`)**
- Dashboard (tenant-scoped; “own only” for executives), leads list (filters, unassigned view, bulk
  assign/status/tag/archive — no export), lead profile (reveal, status, stage, owner, deal fields,
  custom fields, notes, communication log with consent enforcement, tasks, follow-up scheduling,
  attachments, stage history, duplicate warning + merge, read-only attribution), Kanban pipeline with
  drag-and-drop and table view (stagnant flags, approval stages), tasks (mine/team/delegated,
  recurring, delegation, completion notes, month calendar), team (performance vs monthly targets,
  teams, ownership transfer, invitations, role changes, deactivation), analytics (rates, trends, source
  performance, productivity, lost reasons, pipeline value, report builder), settings (profile,
  security preferences that can only tighten, custom fields, pipeline stages, roles, templates, audit trail).

**Smart import** (`/admin/imports`)
- Auto-detects delimiter (`,` `;` tab `|`), encoding (UTF-8/UTF-16/Windows-1252), the header row (skips
  title/blank rows, or "no header"), and the most populated XLSX worksheet. Columns are matched by header
  synonyms *and* cell content (emails, phones, countries, names, dates…) with a confidence score and reasons;
  unknown populated columns become custom fields. Countries are normalised from names/aliases, and phone
  numbers are parsed against each row's own country.
- 5-step wizard (File → Columns → Rules → Review → Import), every step clickable with Back; every change
  autosaves as a draft (`PATCH /api/v1/imports/:id/draft`) and drafts resume where they were left
  (Drafts card on the import center). Editing after validation returns the batch to an unvalidated draft.
- **Smart auto-import** toggle: upload → detect → validate → import automatically when ≤25 % of rows are
  invalid; otherwise it stops at Review with an explanation.

**Email** (`/admin/email` and `/app/email`, permissions `email.send`/`email.manage` and
`crm.email.send`/`crm.email.manage`; workspace feature flag `email`)
- SMTP senders per platform and per workspace: provider quick-setup, verify (live SMTP handshake),
  default sender, per-minute and daily limits. Passwords are AES-GCM encrypted with the app key and never
  returned. Workspace hosts must resolve to public IPs (SSRF guard; the connection is pinned to the
  resolved IP). `SMTP_ALLOW_PRIVATE_HOSTS=true` lifts this for local development only.
- Block email editor: heading/text (TipTap rich text)/button/image/columns/quote/divider/spacer/footer/HTML,
  drag to reorder, undo/redo, global styles and themes, desktop/mobile preview with sample data,
  personalisation variables, test sends, copy HTML. Templates are saved per scope with thumbnails;
  presets included. HTML is sanitised server-side and rendered as table-based, client-safe markup.
- Campaigns from lead selections (bulk actions in lead lists, "email all matching", single lead):
  queued on the `email` worker queue, throttled per sender, deferred past daily caps, cancel and retry
  failed. Recipients without an address, unsubscribed (suppression list) or opted out are skipped.
  Each message has a status (queued/sending/sent/failed/skipped/cancelled), approximate open tracking
  (pixel) and a one-click unsubscribe link (`/unsubscribe/:token`) that also records consent opt-out.
  Delivery log with masked recipients; sent mail is recorded on the lead's communication timeline.
- System mail (invitations, resets) uses `SMTP_URL`, else the platform default verified sender, else the outbox.
- **Welcome emails** (Email → Welcome emails; needs `email.manage` + `orgs.create`, `src/server/services/welcome.ts`):
  when an import completes, the leads it *inserted* (optionally only from chosen sources) are queued as a
  platform campaign with audience kind `welcome` — immediately, after a delay, or at a daily time in a
  chosen time zone. Just before each message is sent, `provisionWelcomeAccount` creates a workspace named
  after the lead's company with the lead as Client Owner and a random temporary password that exists only
  in memory for that one email (never in the subject, the message log or the database in plain text).
  Such users carry `mustChangePassword`; every page and API call is restricted to
  `/account/change-password` until they pick their own, and the temporary password stops working after
  `tempPasswordExpiresAt`. Existing accounts are skipped and never modified; an import is welcomed at most
  once, and past imports can be sent manually from the same tab.
- **Email endpoints** (Email → Endpoints; `email.manage`; `src/server/services/endpoints.ts`, options schema in
  `src/lib/email/endpoints.ts`): named triggers with attached templates. A trigger is a platform event
  (`lead.created`, `import.completed`, `leads.distributed`, `organization.created`, `account.welcome_created`,
  `onboarding.submitted`, `order.created`, `order.fulfilled` — emitted via `emitEmailEvent`, a no-op when no
  endpoint listens) or an inbound webhook `POST /api/v1/public/email/:slug` (Bearer token stored as SHA-256,
  optional `X-Markeetor-Signature: t=,v1=` HMAC with 5-minute tolerance, IP allowlist, `Idempotency-Key`,
  256 KB limit). Each trigger becomes an `EmailEndpointEvent` (accepted / filtered / duplicate / throttled /
  paused / no recipients / rejected) and one `EmailMessage` per recipient × attached email, scheduled by the
  email's delay and the endpoint's send window. Options: payload-path or fixed recipients, CC/BCC/reply-to,
  all/any conditions, custom variables (every payload field is also available by name and camel-cased
  path), dedupe window, per-recipient frequency cap, hourly trigger cap, unique-ID path, open/click
  tracking, test mode, transactional vs marketing (unsubscribe header + suppression), payload retention.
  The `email` worker claims each message atomically, re-checks window/suppression/cap/sender per-minute and
  daily limits (deferring rather than failing), and retries transient SMTP errors at 1/5/15 minutes;
  `endpoint-sweep` (every minute) re-queues messages whose job was lost and un-sticks interrupted sends;
  `endpoint-purge` (daily) erases payloads and message variables past retention. Clicks go through signed
  `/api/v1/email/c/:token` redirects (no open redirect).
- **Deliverability** (`src/server/services/deliverability.ts`, `src/lib/email/spam-check.ts`): every SMTP
  connection greets with the From domain (not the machine hostname) and DKIM-signs when a sender has a verified
  key (Senders → Deliverability → Create DKIM key; private key AES-encrypted, enabled only once the TXT record
  is visible in DNS). Bulk mail carries RFC 8058 one-click `List-Unsubscribe` pointing at
  `/api/v1/email/unsubscribe/:token` (POST unsubscribes, GET redirects to the page) plus `Feedback-ID`; system mail
  carries `Auto-Submitted`. Open pixels and click redirects are only added when `APP_URL` is a public https origin.
  The per-sender checker scores SPF (with the provider's include), DKIM (own key or provider selectors), DMARC,
  MX, free-mail From domains, mailbox/From mismatch, APP_URL and volume, and returns the exact DNS records to add.
  The email editor shows a live content spam check (subject, trigger wording, shorteners, insecure/private links,
  link-text mismatch, image ratio, placeholder images, empty buttons, unsubscribe link).
- **Mail history** (Email → History; also per endpoint): every platform email with filters (status,
  opened/clicked, source, dates, exact address), totals, CSV export (full addresses need `leads.export`), and
  a per-message timeline in `email_message_events` (queued, deferred, sent, retry, failed, skipped,
  cancelled, opened, clicked, unsubscribed, resent) with a re-rendered preview, resend and cancel.

**Lead marketplace, pricing & announcements**
- Clients (`/app/marketplace`, permission `crm.marketplace.view`, workspace feature `marketplace`) browse every
  lead the platform can offer — valid, unallocated, not reserved — with **no identifying data**: the API
  selects only country/state/industry/source/campaign/score/priority/age and derived flags (has email/phone,
  seniority), and client filters are whitelisted (free-text search is dropped so names can't be probed).
  “My leads” (allotted) and the marketplace are separate pages.
- Request one lead or many (selection or “all matching”, capped per request). Leads are reserved atomically,
  priced by the pricing rules, and delivered through the normal distribution engine (same audit, history and
  tracking). Each workspace gets **10 free demo leads** (configurable, per-client overrides), applied to the
  highest-priced leads first; fully-free requests are delivered instantly. Paid requests need the client to
  accept the charges and are approved by platform staff (or instantly if configured); billing covers only
  leads actually delivered, with an invoice number. Admins approve/reject (leads are released) and mark
  invoices paid/waived/void; clients can cancel pending requests and see invoices, balances and the price list
  on `/app/billing` (printable invoices).
- Pricing (Admin → Marketplace → Pricing & rules, `marketplace.manage`): currency, standard/minimum price, tax,
  per-request cap, ordered rules (conditions on industry, country, state, source, campaign, priority, score,
  age, times distributed → set / add / multiply), volume discount tiers, client-specific discounts and free
  allowances, approval policy, price-list visibility, and a live price tester. Shared engine: `src/lib/pricing.ts`.
- Dynamic pricing (same page, `pricing.dynamic`): each lead's price = standard price → **+% per kind of information**
  it carries (email, business email, phone, verified mobile, job title, decision-maker, location, company name,
  industry, live website, description, size, CIN/LLPIN, LinkedIn — signals computed server-side by `leadInfo()` in
  `src/server/services/marketplace.ts` from the lead and its research) → **+research premium** scaled by research
  confidence → custom rules → **age depreciation** (−x% every N days after a grace period, compounding, floored at
  y% of the price) → **resale depreciation** (−x% per previous delivery, floored) → min/max price. `priceLead()`
  returns every step for the admin's price tester and Catalog impact; **clients only ever receive the final price**
  (no steps, rule names or labels — quote lines are just “Marketplace lead”). The client price list (if enabled)
  keeps a plain-language summary. Presets, a depreciation curve preview, and **Catalog impact** (`POST /api/v1/marketplace/pricing/preview`
  re-prices up to 2,000 available leads under unsaved settings, with information coverage and example breakdowns).
  Saved settings without a `dynamic` block get the defaults (enabled). If a custom rule also uses age/times sold,
  the editor warns that both apply.
- **Lead credits** (Admin → Marketplace → Credits; rules in `src/lib/credits.ts`, service `src/server/services/credits.ts`,
  setting `credits`). Prepaid credits clients buy from the platform team and spend on marketplace leads.
  - Ledger: `credit_entries` is append-only (PURCHASE, BONUS, WELCOME, GRANT, SPEND, REFUND, ADJUSTMENT, EXPIRY) with
    `balanceAfter`; `credit_wallets.balance` is its running total, changed only under a `FOR UPDATE` row lock and
    guarded by a `balance >= 0` check constraint. Positive entries are lots (`remaining`, `expiresAt`): spending takes
    the soonest-expiring credits first; expired lots become EXPIRY entries when the wallet is next touched. All three
    tables are tenant-isolated with RLS.
  - Buying: client picks a pack or a custom amount (bonus tiers, per-client bonus, tax) → `credit_requests` PENDING →
    admin sends payment details (AWAITING_PAYMENT) → client reports a payment reference → admin confirms payment
    (method, reference, amount received, optional goodwill credits; step-up auth, row-locked so credits are never
    added twice) → COMPLETED with receipt number `CRI-…`; or declined / cancelled. Every step notifies the other side
    and is audited.
  - Spending: lead requests take `paymentMethod: 'CREDITS'`. Cost = pre-tax quote (after free leads, volume, account
    and coupon discounts) ÷ credit value, or a fixed number per paid lead, minus the credit discount (per-client
    override), rounded up. Credits are held at request time in the same transaction as the lead reservation, settled
    on delivery (undelivered leads refunded), fully refunded on reject/cancel; the request is billed PAID. Optional
    instant delivery for credit-paid requests and an option to require credits (no invoices).
  - Admin: queue with timeline, client wallets (balance, received, spent, expiring), full ledger filterable by client
    and type, manual add/remove with reason and expiry, rules editor (packs, custom amounts, bonus tiers, value, cost
    mode, discount, tax, expiry, welcome credits, low-balance alert, payment instructions/methods, per-client rules).
  - Client: Billing → Credits (balance, lifetime, expiring, purchases with payment instructions and “I’ve paid”,
    printable receipts, history), and “Pay with credits / Invoice” in the request dialog with a buy-credits shortcut.
- **Client growth features** (platform rules: Admin → Marketplace → Growth, setting `growth`; workspace rules:
  Settings → Automation, `organizations.settings.automation`):
  - *Saved searches* (`saved_searches`, `src/server/services/saved-searches.ts`): save marketplace filters; the worker
    (`automation:saved-searches`, every 15 min) finds leads newer than each search's cursor, alerts in-app/email and,
    with **auto-buy**, requests them paid with credits within a weekly cap (per search and platform-wide) and an
    optional max price. Requests are tagged `[auto:<searchId>]` for the cap. Deep link `/app/marketplace?search=<id>`.
  - *Watchlist & compare* (`market_watches`): star leads; Watchlist tab compares up to 4 side by side; leads sold to
    others drop out automatically.
  - *Lead quality guarantee* (`lead_disputes`, `src/server/services/disputes.ts`): a workspace reports a purchased
    (non-free) lead within the window (default 7 days); abuse cap on % of 30-day purchases; admins approve/reject in
    Marketplace → Quality reports (or reasons auto-approve). Approval refunds the lead's share of credits (or its
    price ÷ credit value for invoiced leads) × refund %, as a REFUND ledger entry, and for contact problems marks the
    master lead INVALID so it is never sold again. Row-locked, one report per lead.
  - *Lead ROI* (`/app/roi`, `src/server/services/roi.ts`): spend (invoices + credits × value), funnel, win rate,
    revenue (deal value of won leads), ROI multiple, cost per lead / win, speed-to-lead (median, % within SLA,
    uncontacted ageing), monthly cohorts, by industry and by rep. Weekly email to workspace admins
    (`automation:weekly-reports`, Mondays 08:00).
  - *Today* (`/app/today`): never-contacted leads (best first, SLA breach), overdue / due-today follow-ups, due tasks,
    going-cold leads; my work vs whole team.
  - *Lead page*: one-tap **Call / WhatsApp** (logged reveal → `tel:` / `wa.me` → one-click outcome logging; "wrong
    number" opens a quality report), **Report a problem**, and the **AI assistant** (rule-based next best action;
    intro / follow-up / WhatsApp drafts written by Claude when AI and lead-data egress are enabled — only first name,
    company facts and contact history are sent, never contact details — otherwise safe templates).
  - *Workspace automation* (`src/server/services/workspace-automation.ts`): auto-assignment of delivered leads
    (round-robin pool or rules by industry/state/country/city/source, run after every delivery batch), per-member
    spending limits (per request / per month; workspace admins exempt; enforced in `createLeadRequest`), and signed
    **webhooks** (`leads.delivered`, `lead.status_changed`, `dispute.decided`; header
    `X-LeadsCRM-Signature: t=<unix>,v1=<HMAC-SHA256(secret, "t.body")>`; https only, SSRF-safe DNS, retried with
    backoff; history in `webhook_deliveries`, test button).
  - *Referrals* (`referral_codes`, `referrals`): each workspace gets `/join?ref=CODE` (forwards to the homepage or newest
    published sign-up form); the code is stored on the application and linked on approval; both workspaces get credits
    when the new one makes its first paid purchase (credit purchase or paid lead request). Idempotent.
  - *Getting started* checklist on the client dashboard (dismissible).
- **Super-admin business tools**:
  - *Insights* (`/admin/insights`, `src/server/services/insights.ts`): revenue (billed lead invoices, credit sales,
    collected, tax, orders/AOV, period-over-period, daily series, top clients, credits sold/spent/held and the credit
    liability), inventory (stock, fresh vs resold, age buckets, leads at the age-pricing floor, sell-through and days
    of cover by industry, regions), demand (client marketplace searches logged once per user per hour in
    `market_search_logs`: top industries/locations/keywords with stock, zero-result searches = what to source,
    saved-search interests) and receivables (unpaid invoices by age, credit purchases awaiting payment).
  - *Suppliers* (`/admin/suppliers`, `lead_suppliers`): suppliers own lead `source` values and a cost per lead;
    per supplier: leads in, sold, sell-through, revenue, cost, profit/margin, quality-report rate, invalid leads,
    client win rate and a 0–100 quality score; unmapped sources listed; "pull stock" archives unsold leads.
  - *Client health* (`/admin/health`, `src/server/services/health.ts`): 0–100 score (engagement 30, lead handling 30,
    buying trend 25, satisfaction 15) with reasons, statuses healthy / watch / at risk and a "ready to grow" flag;
    organization page → **Timeline** tab = health card + every action, credit movement, invoice and sign-in.
  - *Alert rules* (`/admin/alerts`, `alert_rules`, `alert_rule_events`, worker `automation:alert-rules` every 15 min):
    client credits low, stock low (optionally per industry), lead/credit requests waiting, supplier report rate, client
    health, yesterday's revenue, failed jobs; per-entity cooldown in Redis; bell + optional email; preview ("check now").
  - *Finance* (`/admin/finance`, setting `finance`, `tax_invoices`): seller details (legal name, GSTIN → state, PAN,
    address); sequential invoices per financial year (`INV/2026-27/0001`, advisory-locked) issued automatically for
    completed credit purchases and invoiced lead purchases (credit-paid lead requests are not invoiced again), with
    seller/buyer snapshots, SAC code, CGST+SGST in-state or IGST inter-state, amount in words, paid/due status kept in
    sync with billing; monthly GST summary for filing. Clients add legal name / GSTIN / state in Settings → General
    (admins on the organization profile) and see their tax invoices on Billing.
  - *Razorpay* (`src/server/services/payments.ts`): credit requests can be paid online — Orders API → Checkout →
    signature `HMAC(order_id|payment_id)` verified → credit request completed (credits, receipt, invoice); the signed
    webhook (`/api/v1/public/razorpay/webhook`) settles server-to-server and is idempotent. Needs `RAZORPAY_KEY_ID`,
    `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`; CSP allows checkout.razorpay.com / api.razorpay.com.
  - *System health* (`/admin/system`): database latency, Redis, worker heartbeat, SMTP/AI/Razorpay configuration,
    queue counts per queue, recent failed jobs with retry (one or all), last-24h emails, webhooks, research, payments
    and alerts.
- **Mobile & tablet layout** (verified at 320, 375, 768 and 1440 px on every admin, client and public page and tab):
  - *Tables* turn into two-column cards below 640 px (`globals.css`). `DataTable`/`SimpleTable` label their own cells
    (`data-label`, first labelled column = card title, selection checkbox in the corner); hand-written tables with a
    `<thead>` are labelled by `components/shell/responsive-tables.tsx`. Opt a table out with `.table-keep`.
  - *Dialogs* open as bottom sheets on phones, drawers go full screen, tab strips scroll sideways, card headers and
    page actions wrap, the sidebar is a drawer below 1024 px (Escape closes it, page scroll locked), safe areas are
    respected, and inputs use 16 px text on phones (no iOS zoom).
  - Conventions for new screens: give responsive grids a phone column (`grid grid-cols-1 md:grid-cols-2`, never
    `grid md:grid-cols-2`), stack multi-column editor rows with `sm:contents` wrappers (see Settings → Pipeline),
    and don't hide actions behind hover (touch screens show hover-revealed controls automatically).
  - Pipeline board: columns snap one per screen on phones; cards are picked up with a short press-and-hold.
- **Marketing tools** (client `/app/marketing`, lead-page *Marketing* card; admin `/admin/marketing`; settings key
  `marketing`, schema in `src/lib/marketing.ts`; services `marketing.ts`, `sequences.ts`, `capture.ts`; tested in
  `tests/integration/marketing.test.ts`):
  - *Sequences*: multi-step follow-ups (email template / WhatsApp / SMS / task) with delays; stop on reply, on chosen
    statuses, on opt-out; enrol leads, a segment, or auto-enrol new segment members; start from the platform library.
    The worker's `marketing-tick` (every 60 s) runs due steps and broadcasts.
  - *WhatsApp & SMS*: provider adapters (WhatsApp Cloud API, Twilio) or **test mode** (recorded, not delivered).
    Every send checks the feature switch, provider, quiet hours (automated sends wait), daily cap, consent and
    blocked words, charges credits (refunded on failure) and logs a verified communication on the lead. Signed
    WhatsApp webhook `/api/v1/public/whatsapp/webhook`: delivery receipts, replies stop sequences, STOP opts out.
  - *Broadcasts* to a segment (large ones held for admin approval); *segments* (saved filters with live counts);
    *lead forms* — hosted `/f/<slug>` and embeddable (`?embed=1`, `frame-ancestors *` for that path only), honeypot,
    rate-limited, deduplicated by email/phone, consent recorded, optional sequence; *tracked links* `/l/<code>`
    with UTM, per-lead click attribution (`{link:CODE}` merge tag) and QR codes; *AI writer* (Claude when enabled,
    otherwise free templates; 7 formats, Indian languages and Hinglish).
  - *Admin control centre*: master switch and per-feature switches, per-client overrides, credit pricing, limits,
    quiet hours, providers with env status, moderation (form review, broadcast threshold, blocked words), review
    queue, and the shared template library (starter templates seeded).
- **Lead Finder understanding** (`src/server/services/finder-nlu.ts`, unit-tested in `tests/unit/finder-nlu.test.ts`):
  industries via concept synonyms (builders → Real Estate, NBFC → Financial Services…) and typo tolerance (never
  matching role words like "managers" to an industry); countries/states/cities with aliases (Bangalore → Bengaluru,
  USA, UAE; short codes like UP/NY only when typed in capitals); exclusions ("not in Kerala", "except insurance",
  "no real estate" → `exclude*` fields → `not_in` filters); replace vs add ("Canada instead", "what about Pune",
  "only healthcare"; switching place clears place exclusions); removals ("remove the phone filter", "any location");
  numbers in words/k/lakh/commas, scores (70+, above 75, below 40), budgets with ₹/$/rupees, recency (last 2 weeks),
  extended seniority (MD, proprietor, GM, VP…). Keyword niches are only added if they keep results non-empty with the
  current criteria; unknown niches get "closest: …". Zero results suggest single drops, else an ordered relaxation
  (soft filters → location → industry last). With AI on, Claude (default `claude-opus-5-5`) gets a strict criteria
  schema, the parser's reading as a hint, a `find_values` catalog lookup tool and `count_leads`; its output is mapped
  onto canonical catalog values (`sanitize`/`canonical`).
- Announcements (`/admin/announcements`, `notifications.broadcast`): send to all or selected workspaces
  (optionally marketplace users only) — delivered to the notification bell and shown as a dismissible banner on
  the client dashboard, with read counts. **New-lead announcements** go out automatically ~2 minutes after an
  import (10 minutes after manual additions, bursts collapse into one) summarising what became available;
  can be switched off or triggered manually.

**Coupons** (Admin → Marketplace → Coupons, `marketplace.manage`)
- Percentage (optional cap), fixed-amount or extra-free-leads coupons with start/end dates, total and
  per-client limits, minimum leads / order value, first-request-only, client targeting, and visibility.
  Visible coupons appear as “Offers for you” on the client dashboard, marketplace and billing pages and as
  one-click chips in the request dialog; hidden codes work when typed. Coupons apply after volume/account
  discounts and before tax (shared engine `src/lib/pricing.ts`). Redemptions are locked inside the request
  transaction, re-priced on delivery, released on reject/cancel/no delivery, and kept for the billing trail
  (used coupons are deactivated, not deleted). Usage and value given are shown per coupon.

**Lead Finder** (client dashboard card + floating assistant on every client page; `crm.marketplace.view`)
- Conversational search over the marketplace. It understands free text against the live catalog (industries,
  countries, states, sources, campaigns — with synonyms, aliases and typo tolerance), seniority, score, freshness,
  must-have email/phone, quantity and budget; asks one focused question at a time with live counts; skips
  questions the catalog has no data for; relaxes impossible filters with counted suggestions; and returns a
  results card (masked sample, breakdown, price range, estimate with free leads) with one-click Request and
  “Browse all”. Prebuilt FAQ answers (free leads, pricing, visibility, coupons, approval, exclusivity) use live
  settings. Engine: built-in by default; when AI is enabled with `AI_PROVIDER_API_KEY` (Anthropic), Claude
  (`AI_MODEL`, default `claude-sonnet-5`) drives the conversation via tool use — it only receives aggregate,
  non-identifying catalog statistics and counts, never individual leads; values are validated against the catalog.

**AI lead research (enrichment)** (Lead repository → “Research with AI” bulk action, AI research tab, lead page card; `leads.enrich`)
- Per lead: (1) checks — email syntax, MX record, free/disposable domain; phone validity and line type via
  libphonenumber, including numbers imported with the wrong country code (e.g. Indian mobiles saved as
  `+1…`), which are corrected when the lead’s country/state makes the right number unambiguous;
  seniority/department from the job title; business-style names (“… Pvt Ltd”) recognised as the company.
  (2) company domain — website field, else business email domain (with MX), else an optional Brave Search
  lookup by company name (`BRAVE_SEARCH_API_KEY`). (3) crawl — homepage + up to 3 about/contact/services
  pages, robots.txt honoured (incl. crawl-delay), SSRF-safe fetcher (every connection’s resolved IP is
  checked: no private/loopback/link-local/metadata ranges, manual redirects re-validated, 8 s timeout,
  1.5 MB cap, HTML only), cached per domain for 14 days with a Redis lock so a company is fetched once.
  (4) profile — Claude (when AI is enabled) fills a strict schema from the crawled text only (null when not
  stated, website text treated as untrusted), otherwise JSON-LD/meta/keyword rules; every field keeps a
  confidence and source URL. Personal data goes to the AI provider only when Settings → AI allows egress.
  (5) save — company/industry fill empty fields (or overwrite, or not at all) above a minimum confidence;
  the rest goes to `customFields.enrichment`; a search index (company name stripped) is stored.
- Bulk runs go through the `enrichment` queue (6 concurrent, max 4 starts/s, sorted by domain for cache
  hits), skip leads researched within the refresh window unless forced, show live progress, and can be
  stopped. Optional auto-research of every new import. Interrupted runs are marked failed for retry.
- Search accuracy: the Lead Finder (client, public form and homepage) now understands niche business terms
  that are not industry names (“roofing”, “dental clinic”) and matches them against industries and what
  research learned about each company (`keyword` filter, also available to marketplace requests — it
  never matches company names, so it can’t be used to identify a business).

**Deep company research & verified directory links**
- Research order per company: its own website (crawl) → shared result for the same company → **deep web research**
  (Claude Opus 5.5 with the `web_search_20260209` tool, when AI is enabled and Settings → AI research allows
  it: searches the company site, registries and directories, records a strict company-level schema — legal
  name, website, CIN/LLPIN, industry, specialty, description, products, size, founded, HQ, status, B2B/B2C,
  company LinkedIn page — with source URLs; no fields for people or contacts; server-side `fallbacks:
  "default"`) → **Wikidata** (free, notable companies) → registry APIs/CIN. A website found by web research or
  Wikidata is crawled too. Partial results created before deep research was available are deepened on the
  next client “Research”.
- Directory links follow URL patterns verified on the live sites: with a CIN, ZaubaCorp (`/companysearchresults/
  <CIN>` → company page), Falcon eBiz (`/company/<slug>-<CIN>`), Tofler (`/<slug>/company/<CIN>`), The Company
  Check (`/company/<slug>/<CIN>`) and OpenCorporates (`/companies/in/<CIN>`) open the exact company page; LLPINs
  work on all of them except Falcon eBiz. Without an identifier only real name searches are linked (ZaubaCorp,
  OpenCorporates, Tracxn after sign-in, Crunchbase, LinkedIn, Google), using the core name (legal suffixes
  dropped, which ZaubaCorp needs). The platform team can paste a CIN/LLPIN on the admin research card; it is
  saved for the company and unlocks registry data and direct pages for every viewer.

**Client company research** (marketplace preview panel and the Company card on a client’s lead; settings in Lead repository → AI research)
- Any client can research a company that hasn’t been researched: “Research this company” runs the same
  pipeline as the admin (synchronously, typically 5–15 s). Results are stored once on the platform’s master
  lead, so every later viewer — in any workspace — gets them instantly; researching again within the refresh
  window returns the saved result without using a credit. Concurrent requests for the same lead share one run.
- Each workspace has a daily allowance (`enrichment.policy.clientDailyLimit`, default 30; failed runs are
  refunded); admins can switch client research off. For a delivered lead the workspace sees the fuller
  profile (website, LinkedIn) and empty company/industry fields on its copy are filled in — never overwritten.
- More robust discovery when there is no website or business email: reuse of a company already researched
  for another lead (same domain or same company name → profile copied, no new crawl or AI call), the optional
  search API, then verified guesses of the company’s address (e.g. “Akshar Eye Clinic” → akshareyeclinic.com /
  .in / .co.in by region): parallel DNS checks, at most three page fetches, accepted only when the site’s own
  title/name carries the company name. Page-title parsing now skips “Home/Welcome” and prefers brand-like parts.

**Company registry data & directory links** (research pipeline; shown in the marketplace panel, the client Company card and the admin research card)
- Official registration facts — legal name, CIN/registration no., status, incorporation date and age, company
  type and listing, RoC and registered district/state, registered activity, paid-up/authorised capital —
  from, in order: the **Falcon eBiz API** (MCA master data; `FALCONEBIZ_API_KEY`, `FALCONEBIZ_DOMAIN`; name →
  best-matching CIN with state tie-break → company details), the **OpenCorporates API**
  (`OPENCORPORATES_API_TOKEN`), or free: a **CIN printed anywhere on the company’s website**, decoded
  (listed/unlisted, state, year, company type). Name matches must be ≥ 0.8 similar (legal suffixes ignored).
  Results are cached per company (`company_registry_records`, 60 days). Directors, addresses, emails and
  charges returned by providers are discarded and never stored.
- Directories that forbid automated access — ZaubaCorp and The Company Check (bot-blocked, HTTP 403),
  Tracxn (`Disallow: /` for all agents) — are never fetched. Instead every company gets one-click links:
  ZaubaCorp, Falcon eBiz, Tofler, The Company Check, MCA (official), Tracxn, OpenCorporates, Crunchbase,
  LinkedIn and Google — site searches by CIN where known, otherwise by name.
- Ask AI can answer registration questions (status, incorporation, type, capital, activity).

**Marketplace company preview & Ask AI** (client marketplace; settings in Admin → Marketplace → Pricing → Company preview)
- Each lead shows its company: the company name (cleaned — never a web address or a whole page title),
  the industry it works in and specialty, what it does, size, founded / years in business, headquarters
  (country / region / city — admin-chosen), sells to businesses or consumers, keywords, and yes/no trust
  signals (business email domain, live website, company LinkedIn page, phone type). Known company names show
  even before research; a person’s name is never used as a company name. Company column, “What the company
  does” search, “With company profile” filter, and a preview panel with “Request this lead”. The panel also shows
  the company's own website and LinkedIn page (toggle “Company website & LinkedIn page”, needs Company name), the
  price breakdown, and what unlocks after purchase (contact person, job title, email, phone). The company's
  phone/email and the lead's contact details are never included before purchase.
- **Research score** (research confidence 0–100, labelled Strong ≥80 / Good ≥60 / Fair ≥40 / Low; shared
  `ResearchScore` component): a sortable Research column in the marketplace (researched leads first, then the
  rest), in the lead panel, in My leads, and on each delivered lead's Company card. `researchOf()` in
  `src/lib/research-score.ts`; unresearched leads show “Not researched”.
- **Ask AI about this company** (`POST /api/v1/marketplace/leads/:id/ask`, 30/min): answers from the research
  profile and the company’s public website text — what it does, services, size, history, markets. Questions
  about owners, founders, staff or contact details are declined; website lines with contact details are
  removed before the model sees them; every answer is scrubbed of emails, phone numbers, URLs and domains.
  Claude when AI is enabled, rule-based answers otherwise.
- Never shown: websites/domains, people’s names and titles, emails, phone numbers, street addresses, social
  links. Descriptions drop any sentence containing contact details. Facts below 60% confidence are left out.
  The company name can be switched off (descriptions are then redacted to “The company”).

**Funnels** (client portal → Funnels; `crm.funnels.manage` to build, `crm.leads.read_all` to view; workspace feature `funnels`)
- A funnel is an ordered list of 2–10 stages, each defined by lead conditions (the same filter builder as the
  Leads page), plus an optional base filter. A lead has *reached* a stage when it matches that stage or any
  later one; it is *in* the stage when it has reached it but no later stage (a stage without conditions
  matches every lead). Counts respect owner-only visibility.
- Analysis: reached / here-now per stage, step conversion, drop-off, deal value, average score, end-to-end
  conversion and the biggest-drop stage. Editing shows a live, debounced recount before saving.
- Templates: sales (by status), your pipeline's stages, engagement, nurture, hot leads — or blank.
- Stage campaigns: email (via the email module, `crm.email.send`), follow-up tasks for each lead's owner, or
  in-app alerts — to the leads in the stage now, or that stage plus later ones (max 5,000), with history
  and email delivery/open stats.
- Stage automations (worker, every 5 minutes): act once per lead that enters a stage (email, task or alert);
  “only new arrivals” baselines the leads already there when switched on. Paused funnels don't run.

**Business onboarding** (platform → Onboarding; `onboarding.manage`; public pages at `/join/<slug>`)
- Form builder with live desktop/mobile preview: up to 8 steps, 17 field types (incl. heading/paragraph/
  divider, rating, consent, country), drag-and-drop ordering, half/full width, options, limits, defaults,
  conditional logic (show when another answer is / isn't / contains / answered / empty). Business name,
  contact name and email are required by the platform and cannot be removed.
- Design: light/dark/auto, accent colour, layout (split left/right, card, minimal), background (plain, grid,
  dots, gradient, image), font, radius, input and button styles, width, density, progress style, logo and
  cover uploads (content-sniffed, safe SVG only). Content: badge, headline, side panel (benefits, stats,
  testimonial), button labels, success screen, footer and legal links.
- Settings: AI Lead Finder on the last step (aggregate counts only; the applicant's criteria are attached to
  the application), business-email requirement, disposable-email blocking, bot protection (honeypot + minimum
  fill time — bots are stored as spam silently), confirmation email, application cap, closing date, auto-
  approve, admin alerts, and the limits applied to new workspaces. Internal settings are never sent to
  applicants.
- Applicant experience: autosave/resume, company and website suggested from the email domain, inline
  validation, step progress. Review queue with quality score and risk signals (personal email, website/email
  mismatch, fast fill, existing client/user, repeat application), notes, reject (optionally notifying), mark
  as spam, and **Approve & activate** — creates the workspace with the chosen limits and emails the owner an
  invitation link to set a password and open their dashboard.

**Site homepage** (form builder → Homepage tab; `onboarding.manage`)
- Any published onboarding form can be set as the site homepage (platform setting `homepage.formId`). Every
  visitor to `/` then sees its landing page; signed-in users get an “Open dashboard” button. Without one,
  or if that form is unpublished, `/` keeps routing to sign-in / the dashboard. Deleting the form clears it.
- Landing page builder with a live, drag-and-drop canvas (desktop preview rendered at 1280px and scaled to
  fit; tablet and phone sizes): click a section to edit it, drag it, move it, hide it or delete it. The
  section list supports the same drag-and-drop.
- Section types: hero (form right/left, centered, image), logo strip (auto-scrolling when long), stats,
  features (18 icons), how it works, testimonials, FAQ accordion, call to action, application form, and free
  text. Each section has an eyebrow, title (`*word*` = accent highlight), subtitle, buttons (go to form /
  sign in / link), columns, a background (plain, muted, glow, grid, accent, inverted), spacing,
  alignment, an anchor for menu links and “hide on mobile”.
- Navigation (sticky, menu links, sign-in link, button, mobile menu), footer (text, links, “Powered by”) and
  SEO title/description. Theme, accent, font, corner radius and button style come from the form’s Design tab.
- Fully responsive via container queries; scroll-reveal uses CSS scroll timelines where supported.
  Links are limited to https, relative, #anchor, mailto and tel URLs. `/` is added to the sitemap.

**Lead Finder homepage** (form builder → Homepage → Homepage style: Lead Finder)
- Chat-first landing page: headline, AI search box, suggested searches, trust points and live inventory
  stats (`{free}` and `{count}` placeholders render live numbers). Look: **Dashboard** (default — the
  dashboards’ design system: black & white, Geist, follows the platform light/dark theme) or **Brand
  colours** (the form’s theme, font and accent). Backdrop: grid, glow, grid + glow or plain.
- The conversation (`POST /api/v1/public/home/finder`, public, 30 requests/min per IP) uses Claude when AI is
  enabled (aggregate counts only) or the built-in engine: it asks one focused question at a time, offers
  quick replies, relaxes impossible filters and answers questions about free leads, visibility, approval
  time, pricing and exclusivity from live settings. Only available while the homepage is in this mode (or
  for staff previewing).
- Results: live match count, quality and contact coverage, top industries/regions and up to six masked
  previews (seniority, industry, location, score, freshness, email/phone available — never names,
  companies, contact details, sources, ids or prices). The first N leads (`pricing.freeLeadsPerClient`)
  are free.
- “Claim my free leads” opens the form’s sign-up with the search attached (the in-form finder is skipped),
  then a confirmation timeline. Signed-in visitors are sent to their dashboard instead.
- Delivery: when the owner of a workspace created from an application accepts the invitation, up to the
  free allowance of the best-scoring matching leads is requested in their name through the normal
  marketplace flow (criteria are relaxed step by step if those leads are gone; exactly once per
  workspace; free leads only, so nothing is billed). The sign-in screen confirms it, and a welcome card on
  the client dashboard links to the delivered leads for two weeks. This applies to any application that
  carries lead interests.

**Appearance, branding & SEO** (Settings → Branding / SEO & indexing / Appearance; `system.manage`)
- Premium light theme alongside dark, driven entirely by CSS tokens (`globals.css`); platform default
  theme (light / dark / system) with an optional per-user switch (account menu + account page, cookie
  `lc_theme`). Explicit themes render server-side; “system” resolves pre-paint — no flash.
- White-label: product name, tagline, monogram, support email; logo, dark-theme logo, favicon and social
  share image uploads (content-sniffed, size-limited; SVGs with scripts/handlers/external references are
  rejected; files served from `/api/v1/branding/:kind` with a sandboxing CSP and immutable cache-busted URLs).
  The brand appears in both portals, sign-in screens, browser tabs, MFA issuer and system emails.
- SEO: site URL (canonical/`metadataBase`), title + title pattern, meta description, keywords, X handle,
  Google/Bing verification tags, Open Graph/Twitter cards. Indexing is **off by default** (robots.txt
  `Disallow: /` + noindex). When enabled, `/robots.txt` allows public pages, always disallows
  `/admin`, `/app`, `/account`, `/api/`, and points to `/sitemap.xml`, whose paths are admin-managed
  (private paths are filtered out). Signed-in layouts are always `noindex`.

**Cross-cutting**: account page (profile, password, MFA enrolment/disable, sessions, sign-in history),
global search (⌘K), notifications, invitation/password-reset flows, OpenAPI 3.1 (`/api/v1/openapi.json`),
structured JSON logs with request ids, optional OpenTelemetry, Docker/Compose, CI workflow, backup/restore.

### Verification performed

* `npm test` — **220 tests passing** (incl. marketing — sends/quiet hours/credits/opt-out, sequences stopping on reply, broadcast review, tracked links & QR, form capture dedupe & enrolment, WhatsApp STOP webhook; a Lead Finder language-understanding suite, GST invoices & numbering, Razorpay signature/webhook settlement, supplier profit, insights, client health, timeline, alert cooldowns, saved searches & auto-buy caps, watchlist, quality guarantee refunds/auto-approve/window, auto-assignment, spending limits, webhooks, ROI maths, Today queue, assistant drafts, referrals, lead credits — purchase lifecycle, holds/settlement/refunds, expiry order, low balance, invoice-off mode, dynamic pricing maths — information/research premiums, age & resale depreciation floors, step order, catalog breakdowns, verified directory URL patterns, deep web research normalisation, manual CIN/LLPIN, CIN decoding, registry providers (directors never kept), client research credits/reuse/sharing, marketplace company preview, Ask AI privacy guardrails, company-name cleaning, lead research — SSRF/robots safety, extraction, phone correction, keyword search; Lead Finder homepage and free-lead delivery, site homepage, funnel stage maths/automations/campaigns, onboarding validation/spam/approval, smart-import detection, email campaigns over a real SMTP server,
  workflow graph validation/branching/waits/legacy resume/automated email, branding uploads and robots rules): allocation planner; normalization/formula escaping/file sniffing;
  filter-compiler hardening; crypto/password policy; cross-tenant reads/writes/reveals (API + raw SQL
  under RLS); IDOR (404s); platform-endpoint denial for clients; export denial + audit; step-up;
  masked data for analysts; owner-only visibility for executives; attribution immutability; CSRF;
  escalation (invite above rank, platform role from workspace, overrides, privileged-role approval,
  self role change); attachments (disguised executables, tenant scoping, permission); concurrent
  allocation (no double assignment), DB-level uniqueness, idempotency, execution-time quota re-check
  + auto-pause, suspended-client exclusion, rollback, reassignment privacy; import end-to-end incl.
  rollback and idempotent resume; audit immutability and chain integrity; login lockout, MFA flow with
  token rotation, MFA enforcement, IP allowlists, session revocation.
* `npm run lint` (0 errors), `npm run typecheck`, `next build` — passing.
* Backup → restore into a scratch database → checksum, row-count and audit-chain verification — passing.
* Manual browser walkthrough of both portals with seeded data.

---

## 5. Known limitations / not implemented

* **Outbound WhatsApp/SMS** is delivered only when an admin selects WhatsApp Cloud / Twilio and the `WHATSAPP_*` /
  `TWILIO_*` variables are set; by default marketing runs in test mode (messages recorded, not delivered).
  WhatsApp Cloud only allows free-form text inside the 24-hour customer window — outside it Meta requires approved
  templates, which are not yet modelled. Social post scheduling, ad-audience export, website visitor tracking and
  A/B tests are not implemented.
* **AI features** are off: `src/server/ai` defines the provider interface, explainability contract and
  egress guard, but no provider is integrated.
* **System email** is delivered only when `SMTP_URL` or a verified platform default sender exists; otherwise
  messages go to the development outbox (bodies hidden in production because they contain single-use links).
* **Email bounces/complaints** are not ingested (no inbound webhook/IMAP); open rates are approximate.
* **Object storage** is a local private directory behind a storage interface; production should swap in
  S3/GCS with server-side encryption. Encryption at rest otherwise relies on disk/volume encryption.
* **TLS** is expected to be terminated by the reverse proxy/load balancer; set `TRUST_PROXY=true` there.
* **CSP** allows `'unsafe-inline'` scripts (Next.js bootstrap); nonce-based CSP is a follow-up.
* **Device restrictions** are not implemented (IP allowlists are). **Attachment downloads** are prevented
  only in the UI sense — inline content can still be saved by a determined user.
* **E2E browser tests** (Playwright) and load/performance tests are not yet automated; API-level and
  service-level tests cover the critical flows. Accessibility was built in (labels, focus rings,
  keyboard-operable Radix primitives, non-colour status cues) but not audited with automated tooling.
* **Approvals** cover privileged invitations and role grants; distribution/automation approvals beyond
  typed confirmation and step-up are not modelled.
* **Single membership per user** (one workspace or the platform). Multi-workspace users would require a
  workspace switcher.
* **Kanban** shows up to 50 cards per stage; use the table view or filters beyond that.
* The lint configuration downgrades `react-hooks/set-state-in-effect`, `react-hooks/purity` and
  `no-explicit-any` to warnings (see `eslint.config.mjs`).
* Prisma blocks `migrate reset` from automated agents; the dev database in this workspace was seeded
  additively and still contains a few records from smoke tests (a test import `IMP-…` and an early batch).

---

## 6. Operations

* **Migrations**: `npm run db:migrate` (`prisma migrate deploy`). The security migration installs RLS
  policies, audit triggers and partial unique indexes — never apply schema changes with `db push`.
* **Roles**: `leads_app` (owner, no superuser, no BYPASSRLS) for the app; `leads_backup`
  (BYPASSRLS + `pg_read_all_data`) for backups; restores run as an admin role. In production, consider a
  separate migration role so the runtime role cannot alter triggers.
* **Backups**: schedule `npm run db:backup`; ship `backups/<ts>/` to encrypted off-site storage;
  rehearse `scripts/restore.sh` into a scratch database (it verifies checksums and the audit chain).
* **Worker**: run ≥ 1 worker; health is visible on the command center (heartbeat < 90 s).
* **Retention**: audit events (default 365 d, min 90), uploaded import files (7 d), raw import rows (30 d),
  expired sessions (90 d) — all configurable in Settings and enforced by the worker.
* **Observability**: pino JSON logs (request id on every API response as `x-request-id`); set
  `OTEL_EXPORTER_OTLP_ENDPOINT` to export traces.
* **Dependency checks**: `npm run audit:deps` (also in CI).

## 7. Repository map

```
prisma/              schema.prisma, migrations (init + security layer), seed.ts, seed-activity.ts
src/app/(auth)       login, MFA, forgot/reset password, invitation acceptance
src/app/admin        platform portal pages            src/app/app   client workspace pages
src/app/api/v1       REST endpoints (route() wrapper)  src/app/account  self-service security
src/components       ui (design system), data (tables, filters, charts, timeline), shell
src/lib              permissions catalog, filter DSL, masking, formatting, API client, hooks
src/server           api wrapper, auth, db/RLS helpers, audit, rate limits, services, jobs, storage
src/worker           BullMQ worker entrypoint
tests/               unit + integration/security suites      scripts/  db setup, backup/restore, openapi
docs/openapi.json    generated API description
```
