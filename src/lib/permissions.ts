/**
 * Permission catalog. Authorization is always evaluated against these keys —
 * never against role names. Platform-scoped permissions can never be attached to
 * an organization-scoped role (enforced in the roles service).
 */
export type Scope = 'PLATFORM' | 'ORGANIZATION';

type Def = { description: string; group: string; sensitive?: boolean };

export const PLATFORM_PERMISSIONS = {
  'platform.dashboard.view': { group: 'Command center', description: 'View the global command center' },
  'orgs.read': { group: 'Organizations', description: 'View client organizations' },
  'orgs.create': { group: 'Organizations', description: 'Create client organizations' },
  'orgs.update': { group: 'Organizations', description: 'Edit organization profiles, settings and features' },
  'orgs.status': { group: 'Organizations', description: 'Activate, suspend, archive and restore workspaces', sensitive: true },
  'orgs.quotas': { group: 'Organizations', description: 'Configure quotas and allocation limits' },
  'users.read': { group: 'Users', description: 'View users, sessions and login history' },
  'users.invite': { group: 'Users', description: 'Invite users' },
  'users.manage': { group: 'Users', description: 'Suspend, reactivate and edit users; reset passwords and MFA', sensitive: true },
  'users.sessions.revoke': { group: 'Users', description: 'Revoke user sessions' },
  'roles.read': { group: 'Roles', description: 'View roles and permissions' },
  'roles.manage': { group: 'Roles', description: 'Create and edit roles, assign roles and overrides', sensitive: true },
  'approvals.decide': { group: 'Roles', description: 'Approve or reject privileged operations', sensitive: true },
  'leads.read': { group: 'Leads', description: 'View the central lead repository (contact details masked)' },
  'leads.reveal': { group: 'Leads', description: 'Reveal masked contact details (audited)', sensitive: true },
  'leads.update': { group: 'Leads', description: 'Edit, tag and annotate master lead records' },
  'leads.enrich': { group: 'Leads', description: 'Run AI research on leads and save the results to the lead record' },
  'leads.archive': { group: 'Leads', description: 'Archive and restore leads' },
  'leads.merge': { group: 'Leads', description: 'Review duplicates and merge leads' },
  'leads.export': { group: 'Leads', description: 'Export lead data (audited, step-up required)', sensitive: true },
  'imports.read': { group: 'Imports', description: 'View import history and row reports' },
  'imports.create': { group: 'Imports', description: 'Upload and process lead files' },
  'imports.rollback': { group: 'Imports', description: 'Roll back completed imports', sensitive: true },
  'distribution.read': { group: 'Distribution', description: 'View distribution batches and assignment history' },
  'distribution.create': { group: 'Distribution', description: 'Allocate leads to client organizations' },
  'distribution.reassign': { group: 'Distribution', description: 'Reassign or revoke allocated leads', sensitive: true },
  'distribution.rollback': { group: 'Distribution', description: 'Roll back distribution batches', sensitive: true },
  'distribution.rules': { group: 'Distribution', description: 'Manage automated distribution rules' },
  'analytics.read': { group: 'Analytics', description: 'View platform analytics' },
  'analytics.export': { group: 'Analytics', description: 'Export aggregated analytics reports', sensitive: true },
  'audit.read': { group: 'Audit', description: 'Search audit logs' },
  'audit.export': { group: 'Audit', description: 'Export audit logs', sensitive: true },
  'audit.admin': { group: 'Audit', description: 'Verify integrity and configure audit retention', sensitive: true },
  'security.read': { group: 'Security', description: 'View the security center' },
  'security.manage': { group: 'Security', description: 'Manage security alerts and platform security policies', sensitive: true },
  'automation.manage': { group: 'Automation', description: 'Manage platform workflows' },
  'email.send': { group: 'Email', description: 'Send email campaigns to master leads and view the email log' },
  'email.manage': { group: 'Email', description: 'Manage platform SMTP senders and email templates', sensitive: true },
  'marketplace.manage': { group: 'Marketplace', description: 'Review client lead requests, manage pricing rules and billing', sensitive: true },
  'notifications.broadcast': { group: 'Marketplace', description: 'Send announcements to client dashboards' },
  'onboarding.manage': { group: 'Onboarding', description: 'Build business onboarding forms and approve new client applications', sensitive: true },
  'system.manage': { group: 'System', description: 'Platform settings, integrations, API keys, jobs and outbox', sensitive: true },
} satisfies Record<string, Def>;

export const ORG_PERMISSIONS = {
  'crm.dashboard.view': { group: 'Dashboard', description: 'View the workspace dashboard' },
  'crm.leads.read_all': { group: 'Leads', description: 'View all leads in the workspace' },
  'crm.leads.read_own': { group: 'Leads', description: 'View leads assigned to me' },
  'crm.leads.update': { group: 'Leads', description: 'Edit lead details, status, priority, tags and follow-ups' },
  'crm.leads.reveal': { group: 'Leads', description: 'Reveal masked contact details (audited)', sensitive: true },
  'crm.leads.assign': { group: 'Leads', description: 'Assign leads to team members' },
  'crm.leads.bulk': { group: 'Leads', description: 'Bulk status and owner updates' },
  'crm.leads.archive': { group: 'Leads', description: 'Archive and restore leads' },
  'crm.leads.merge': { group: 'Leads', description: 'Merge duplicate leads in the workspace' },
  'crm.notes.write': { group: 'Leads', description: 'Add notes' },
  'crm.attachments.upload': { group: 'Attachments', description: 'Upload attachments' },
  'crm.attachments.view': { group: 'Attachments', description: 'View attachments inline (watermarked, audited)', sensitive: true },
  'crm.pipeline.move': { group: 'Pipeline', description: 'Move deals between stages and edit deal values' },
  'crm.pipeline.manage': { group: 'Pipeline', description: 'Configure pipelines and stages' },
  'crm.tasks.read_all': { group: 'Tasks', description: 'View team task lists' },
  'crm.tasks.manage': { group: 'Tasks', description: 'Create, delegate and complete tasks' },
  'crm.comms.log': { group: 'Communication', description: 'Log calls, emails, meetings and consent' },
  'crm.comms.templates': { group: 'Communication', description: 'Manage communication templates' },
  'crm.team.read': { group: 'Team', description: 'View team members and performance' },
  'crm.team.manage': { group: 'Team', description: 'Manage teams, targets and ownership transfers' },
  'crm.users.manage': { group: 'Team', description: 'Invite, deactivate and change roles of workspace users', sensitive: true },
  'crm.analytics.read': { group: 'Analytics', description: 'View workspace analytics' },
  'crm.settings.manage': { group: 'Settings', description: 'Manage workspace settings, branding and custom fields' },
  'crm.roles.manage': { group: 'Settings', description: 'Manage workspace roles', sensitive: true },
  'crm.audit.read': { group: 'Settings', description: 'View the workspace audit trail' },
  'crm.email.send': { group: 'Email', description: 'Send emails and campaigns to visible leads; view the email log' },
  'crm.email.manage': { group: 'Email', description: 'Manage workspace SMTP senders and email templates', sensitive: true },
  'crm.marketplace.view': { group: 'Marketplace', description: 'Browse the lead marketplace (details hidden until delivered)' },
  'crm.marketplace.request': { group: 'Marketplace', description: 'Request and purchase marketplace leads', sensitive: true },
  'crm.billing.view': { group: 'Marketplace', description: 'View lead purchases, invoices and free demo allowance' },
  'crm.funnels.manage': { group: 'Funnels', description: 'Build funnels, launch funnel campaigns and stage automations' },
} satisfies Record<string, Def>;

export type PlatformPermission = keyof typeof PLATFORM_PERMISSIONS;
export type OrgPermission = keyof typeof ORG_PERMISSIONS;
export type PermissionKey = PlatformPermission | OrgPermission;

export const ALL_PERMISSIONS: Record<PermissionKey, Def & { scope: Scope }> = {
  ...Object.fromEntries(Object.entries(PLATFORM_PERMISSIONS).map(([k, v]) => [k, { ...v, scope: 'PLATFORM' as const }])),
  ...Object.fromEntries(Object.entries(ORG_PERMISSIONS).map(([k, v]) => [k, { ...v, scope: 'ORGANIZATION' as const }])),
} as Record<PermissionKey, Def & { scope: Scope }>;

const P = Object.keys(PLATFORM_PERMISSIONS) as PlatformPermission[];
const O = Object.keys(ORG_PERMISSIONS) as OrgPermission[];

export type RoleTemplate = {
  key: string;
  name: string;
  description: string;
  scope: Scope;
  rank: number;
  isPrivileged?: boolean;
  permissions: PermissionKey[];
};

/** System role templates. Seeded once; organizations may define additional custom roles. */
export const SYSTEM_ROLES: RoleTemplate[] = [
  {
    key: 'platform_owner', name: 'Platform Owner', scope: 'PLATFORM', rank: 100, isPrivileged: true,
    description: 'Unrestricted platform administration, including approvals and system configuration.',
    permissions: P,
  },
  {
    key: 'super_admin', name: 'Super Admin', scope: 'PLATFORM', rank: 90, isPrivileged: true,
    description: 'Full operational administration. Cannot change system configuration or audit retention.',
    permissions: P.filter((p) => !['system.manage', 'audit.admin'].includes(p)),
  },
  {
    key: 'lead_ops_manager', name: 'Lead Operations Manager', scope: 'PLATFORM', rank: 60,
    description: 'Imports, lead repository and distribution.',
    permissions: ['platform.dashboard.view', 'orgs.read', 'leads.read', 'leads.update', 'leads.archive', 'leads.merge', 'leads.reveal',
      'imports.read', 'imports.create', 'distribution.read', 'distribution.create', 'distribution.reassign', 'distribution.rules', 'analytics.read', 'email.send',
      'marketplace.manage', 'notifications.broadcast', 'onboarding.manage', 'leads.enrich'],
  },
  {
    key: 'security_admin', name: 'Security Administrator', scope: 'PLATFORM', rank: 70,
    description: 'Security center, sessions, audit and policy management.',
    permissions: ['platform.dashboard.view', 'orgs.read', 'users.read', 'users.manage', 'users.sessions.revoke', 'roles.read', 'audit.read', 'audit.export', 'audit.admin', 'security.read', 'security.manage'],
  },
  {
    key: 'analytics_admin', name: 'Analytics Administrator', scope: 'PLATFORM', rank: 40,
    description: 'Platform analytics and reporting.',
    permissions: ['platform.dashboard.view', 'orgs.read', 'leads.read', 'imports.read', 'distribution.read', 'analytics.read', 'analytics.export'],
  },
  {
    key: 'client_owner', name: 'Client Owner', scope: 'ORGANIZATION', rank: 50,
    description: 'Full control of the client workspace.',
    permissions: O,
  },
  {
    key: 'client_admin', name: 'Client Admin', scope: 'ORGANIZATION', rank: 40,
    description: 'Workspace administration without role management.',
    permissions: O.filter((p) => p !== 'crm.roles.manage'),
  },
  {
    key: 'sales_manager', name: 'Sales Manager', scope: 'ORGANIZATION', rank: 30,
    description: 'Manages a sales team, assigns leads and tracks performance.',
    permissions: ['crm.dashboard.view', 'crm.leads.read_all', 'crm.leads.update', 'crm.leads.reveal', 'crm.leads.assign', 'crm.leads.bulk',
      'crm.leads.archive', 'crm.notes.write', 'crm.attachments.upload', 'crm.attachments.view', 'crm.pipeline.move', 'crm.tasks.read_all',
      'crm.tasks.manage', 'crm.comms.log', 'crm.comms.templates', 'crm.team.read', 'crm.team.manage', 'crm.analytics.read', 'crm.email.send',
      'crm.marketplace.view', 'crm.marketplace.request', 'crm.billing.view', 'crm.funnels.manage'],
  },
  {
    key: 'sales_executive', name: 'Sales Executive', scope: 'ORGANIZATION', rank: 20,
    description: 'Works leads assigned to them.',
    permissions: ['crm.dashboard.view', 'crm.leads.read_own', 'crm.leads.update', 'crm.leads.reveal', 'crm.notes.write',
      'crm.attachments.upload', 'crm.pipeline.move', 'crm.tasks.manage', 'crm.comms.log', 'crm.email.send', 'crm.marketplace.view'],
  },
  {
    key: 'read_only_analyst', name: 'Read-only Analyst', scope: 'ORGANIZATION', rank: 10,
    description: 'Read-only access to workspace leads and analytics. Contact details stay masked.',
    permissions: ['crm.dashboard.view', 'crm.leads.read_all', 'crm.team.read', 'crm.analytics.read', 'crm.marketplace.view', 'crm.billing.view'],
  },
];
