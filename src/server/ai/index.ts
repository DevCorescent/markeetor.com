import { AppError } from '../errors';
import { getSetting } from '../settings';

/**
 * AI extension point — DISABLED unless explicitly configured.
 *
 * Contract for future capabilities (lead scoring, prioritisation, duplicate suggestions, follow-up
 * suggestions, categorisation, natural-language reporting, anomaly detection, rule suggestions):
 *   - every output carries human-readable `reasons` (explainability);
 *   - outputs are advisory: high-impact actions (allocation, merges) require a human to accept them;
 *   - lead data is only sent to an external provider when `ai.config.allowLeadDataEgress` is true,
 *     AI_PROVIDER_API_KEY is configured, and the caller passes only the minimum fields needed.
 * No provider is implemented in this release; see DEVELOPMENT.md → "AI features".
 */
export type Explained<T> = { value: T; reasons: string[]; model: string; advisory: true };

export interface LeadScoringProvider {
  scoreLeads(leads: { id: string; features: Record<string, string | number | null> }[]): Promise<Explained<number>[]>;
}

export async function aiStatus() {
  const cfg = await getSetting('ai.config');
  return { enabled: Boolean(cfg.enabled && process.env.AI_PROVIDER_API_KEY), egressAllowed: Boolean(cfg.allowLeadDataEgress), provider: cfg.provider };
}

/** Guard every AI entry point with this. Throws unless AI is enabled AND data egress is approved. */
export async function assertAiAllowed(opts: { sendsLeadData: boolean }) {
  const s = await aiStatus();
  if (!s.enabled) throw new AppError('PRECONDITION_FAILED', 'AI features are disabled');
  if (opts.sendsLeadData && !s.egressAllowed) throw new AppError('PRECONDITION_FAILED', 'Sending lead data to the AI provider has not been approved');
}

export function getLeadScoringProvider(): LeadScoringProvider | null {
  return null; // No provider integrated yet — callers must handle null.
}
