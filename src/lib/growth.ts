import { z } from 'zod';

/**
 * Platform-wide rules for client growth features (Admin → Marketplace → Growth): saved searches & auto-buy,
 * the lead quality guarantee, and referrals. Shared by server and UI.
 */

export const DISPUTE_REASONS = [
  { key: 'WRONG_NUMBER', label: 'Wrong or dead phone number' },
  { key: 'BOUNCED_EMAIL', label: 'Email bounced' },
  { key: 'WRONG_PERSON', label: 'Not the person described' },
  { key: 'CLOSED_BUSINESS', label: 'Business closed' },
  { key: 'DUPLICATE', label: 'Duplicate of a lead I already had' },
  { key: 'OTHER', label: 'Other problem' },
] as const;
export type DisputeReason = (typeof DISPUTE_REASONS)[number]['key'];
export const DISPUTE_REASON_KEYS = DISPUTE_REASONS.map((r) => r.key) as [DisputeReason, ...DisputeReason[]];
export const disputeReasonLabel = (k: string) => DISPUTE_REASONS.find((r) => r.key === k)?.label ?? k;

export const growthSettingsSchema = z.object({
  savedSearches: z.object({
    enabled: z.boolean().default(true),
    /** Max saved searches per workspace. */
    maxPerWorkspace: z.number().int().min(1).max(100).default(20),
    autoBuyEnabled: z.boolean().default(true),
    /** Hard ceiling on leads bought automatically per search per week. */
    maxAutoBuyPerWeek: z.number().int().min(1).max(5000).default(200),
  }).default({ enabled: true, maxPerWorkspace: 20, autoBuyEnabled: true, maxAutoBuyPerWeek: 200 }),
  guarantee: z.object({
    enabled: z.boolean().default(true),
    /** Days after delivery a lead can be reported. */
    windowDays: z.number().int().min(1).max(90).default(7),
    /** Share of the paid price returned as credits on approval. */
    refundPct: z.number().min(0).max(100).default(100),
    /** Reasons approved without review (the platform team can still see them). */
    autoApproveReasons: z.array(z.enum(DISPUTE_REASON_KEYS)).default([]),
    /** Abuse guard: max share of a workspace's purchased leads (last 30 days) it can report. */
    maxReportPct: z.number().min(1).max(100).default(20),
    /** Mark leads with approved contact problems as invalid so they are never sold again. */
    invalidateOnApproval: z.boolean().default(true),
  }).default({ enabled: true, windowDays: 7, refundPct: 100, autoApproveReasons: [], maxReportPct: 20, invalidateOnApproval: true }),
  referrals: z.object({
    enabled: z.boolean().default(true),
    referrerCredits: z.number().int().min(0).max(1_000_000).default(500),
    refereeCredits: z.number().int().min(0).max(1_000_000).default(250),
  }).default({ enabled: true, referrerCredits: 500, refereeCredits: 250 }),
  /** Weekly performance email to workspace owners. */
  weeklyReport: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
});
export type GrowthSettings = z.infer<typeof growthSettingsSchema>;
export const DEFAULT_GROWTH: GrowthSettings = growthSettingsSchema.parse({});

/** Workspace automation (Settings → Automation), stored in the organization's settings JSON. */
export const workspaceAutomationSchema = z.object({
  autoAssign: z.object({
    mode: z.enum(['off', 'round_robin', 'rules']).default('off'),
    /** Round-robin pool (user ids). Empty = every active member who can own leads. */
    memberIds: z.array(z.string().max(64)).max(200).default([]),
    /** Rules mode: first match wins; unmatched leads fall back to round-robin when `fallback` is on. */
    rules: z.array(z.object({
      field: z.enum(['industry', 'state', 'country', 'city', 'source']),
      values: z.array(z.string().trim().min(1).max(80)).min(1).max(50),
      ownerId: z.string().max(64),
    })).max(50).default([]),
    fallback: z.boolean().default(true),
  }).default({ mode: 'off', memberIds: [], rules: [], fallback: true }),
  spending: z.object({
    /** Per-user limits for members without workspace-admin rights. 0 = no limit. */
    maxCreditsPerRequest: z.number().int().min(0).max(10_000_000).default(0),
    monthlyCreditsPerUser: z.number().int().min(0).max(10_000_000).default(0),
    maxAmountPerRequest: z.number().min(0).max(10_000_000).default(0),
  }).default({ maxCreditsPerRequest: 0, monthlyCreditsPerUser: 0, maxAmountPerRequest: 0 }),
  webhooks: z.array(z.object({
    id: z.string().min(1).max(40),
    url: z.string().url().max(500).refine((u) => u.startsWith('https://'), 'Webhooks must use https://'),
    events: z.array(z.enum(['leads.delivered', 'lead.status_changed', 'dispute.decided'])).min(1),
    secret: z.string().min(16).max(128),
    active: z.boolean().default(true),
  })).max(10).default([]),
});
export type WorkspaceAutomation = z.infer<typeof workspaceAutomationSchema>;
export const DEFAULT_WORKSPACE_AUTOMATION: WorkspaceAutomation = workspaceAutomationSchema.parse({});
