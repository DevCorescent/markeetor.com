/** The research score shown to clients: research confidence (0–100), only once research has run. */
export function researchOf(e: { status: string; confidence: number; finishedAt: Date | null } | null | undefined) {
  return e && (e.status === 'DONE' || e.status === 'PARTIAL') ? { score: e.confidence, status: e.status, researchedAt: e.finishedAt } : null;
}
