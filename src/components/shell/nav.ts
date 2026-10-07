import type { PermissionKey } from '@/lib/permissions';

export type NavItem = { key: string; label: string; href: string; perm?: PermissionKey[]; feature?: string; group?: string };

export const ADMIN_NAV: NavItem[] = [
  { key: 'dashboard', label: 'Command center', href: '/admin', perm: ['platform.dashboard.view'], group: 'Overview' },
  { key: 'analytics', label: 'Analytics', href: '/admin/analytics', perm: ['analytics.read'], group: 'Overview' },
  { key: 'insights', label: 'Insights', href: '/admin/insights', perm: ['analytics.read'], group: 'Overview' },
  { key: 'leads', label: 'Lead repository', href: '/admin/leads', perm: ['leads.read'], group: 'Lead operations' },
  { key: 'imports', label: 'Imports', href: '/admin/imports', perm: ['imports.read'], group: 'Lead operations' },
  { key: 'distribution', label: 'Distribution', href: '/admin/distribution', perm: ['distribution.read'], group: 'Lead operations' },
  { key: 'email', label: 'Email', href: '/admin/email', perm: ['email.send', 'email.manage'], group: 'Lead operations' },
  { key: 'marketing', label: 'Marketing', href: '/admin/marketing', perm: ['email.manage'], group: 'Lead operations' },
  { key: 'suppliers', label: 'Suppliers', href: '/admin/suppliers', perm: ['marketplace.manage'], group: 'Lead operations' },
  { key: 'marketplace', label: 'Marketplace', href: '/admin/marketplace', perm: ['marketplace.manage'], group: 'Clients' },
  { key: 'announcements', label: 'Announcements', href: '/admin/announcements', perm: ['notifications.broadcast'], group: 'Clients' },
  { key: 'onboarding', label: 'Onboarding', href: '/admin/onboarding', perm: ['onboarding.manage'], group: 'Clients' },
  { key: 'orgs', label: 'Organizations', href: '/admin/organizations', perm: ['orgs.read'], group: 'Clients' },
  { key: 'health', label: 'Client health', href: '/admin/health', perm: ['orgs.read'], group: 'Clients' },
  { key: 'finance', label: 'Finance', href: '/admin/finance', perm: ['marketplace.manage'], group: 'Clients' },
  { key: 'alerts', label: 'Alert rules', href: '/admin/alerts', perm: ['marketplace.manage'], group: 'Clients' },
  { key: 'users', label: 'Users', href: '/admin/users', perm: ['users.read'], group: 'Access' },
  { key: 'roles', label: 'Roles', href: '/admin/roles', perm: ['roles.read'], group: 'Access' },
  { key: 'approvals', label: 'Approvals', href: '/admin/approvals', perm: ['approvals.decide'], group: 'Access' },
  { key: 'security', label: 'Security center', href: '/admin/security', perm: ['security.read'], group: 'Governance' },
  { key: 'audit', label: 'Audit log', href: '/admin/audit', perm: ['audit.read'], group: 'Governance' },
  { key: 'automation', label: 'Automation', href: '/admin/automation', perm: ['automation.manage'], group: 'Governance' },
  { key: 'system', label: 'System health', href: '/admin/system', perm: ['system.manage'], group: 'Governance' },
  { key: 'settings', label: 'Settings', href: '/admin/settings', perm: ['system.manage'], group: 'Governance' },
];

export const APP_NAV: NavItem[] = [
  { key: 'dashboard', label: 'Dashboard', href: '/app', perm: ['crm.dashboard.view'], group: 'Workspace' },
  { key: 'today', label: 'Today', href: '/app/today', perm: ['crm.leads.read_all', 'crm.leads.read_own'], group: 'Workspace' },
  { key: 'leads', label: 'My leads', href: '/app/leads', perm: ['crm.leads.read_all', 'crm.leads.read_own'], group: 'Workspace' },
  { key: 'marketplace', label: 'Lead marketplace', href: '/app/marketplace', perm: ['crm.marketplace.view'], feature: 'marketplace', group: 'Workspace' },
  { key: 'funnels', label: 'Funnels', href: '/app/funnels', perm: ['crm.funnels.manage', 'crm.leads.read_all'], feature: 'funnels', group: 'Workspace' },
  { key: 'pipeline', label: 'Pipeline', href: '/app/pipeline', perm: ['crm.leads.read_all', 'crm.leads.read_own'], feature: 'pipeline', group: 'Workspace' },
  { key: 'email', label: 'Email', href: '/app/email', perm: ['crm.email.send', 'crm.email.manage'], feature: 'email', group: 'Workspace' },
  { key: 'marketing', label: 'Marketing', href: '/app/marketing', perm: ['crm.email.send', 'crm.email.manage'], group: 'Workspace' },
  { key: 'tasks', label: 'Tasks', href: '/app/tasks', perm: ['crm.tasks.manage', 'crm.tasks.read_all'], feature: 'tasks', group: 'Workspace' },
  { key: 'team', label: 'Team', href: '/app/team', perm: ['crm.team.read'], feature: 'teams', group: 'Management' },
  { key: 'analytics', label: 'Analytics', href: '/app/analytics', perm: ['crm.analytics.read'], feature: 'analytics', group: 'Management' },
  { key: 'roi', label: 'Lead ROI', href: '/app/roi', perm: ['crm.analytics.read', 'crm.dashboard.view'], group: 'Management' },
  { key: 'billing', label: 'Billing', href: '/app/billing', perm: ['crm.billing.view'], feature: 'marketplace', group: 'Management' },
  { key: 'settings', label: 'Settings', href: '/app/settings', perm: ['crm.settings.manage', 'crm.users.manage', 'crm.roles.manage', 'crm.pipeline.manage', 'crm.comms.templates', 'crm.audit.read'], group: 'Management' },
];

export function visibleNav(items: NavItem[], permissions: Set<string>, features?: Record<string, boolean>) {
  return items.filter((i) => (!i.perm || i.perm.some((p) => permissions.has(p))) && (!i.feature || features?.[i.feature] !== false));
}
