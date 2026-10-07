import { idParam, route } from '@/server/api';
import { draftSchema, saveDraft } from '@/server/services/imports';

/** Autosave endpoint for the import wizard. Saves progress without validating so users can step back and resume. */
export const PATCH = route({ perm: 'imports.create', body: draftSchema, rate: { bucket: 'import-draft', limit: 600, windowSec: 600 } }, async ({ ctx, params, body }) => {
  const b = await saveDraft(ctx, idParam(params), body);
  return { ok: true, status: b.status, draftStep: b.draftStep, mapping: b.mapping, headers: b.headers, detection: b.detection, headerRow: b.headerRow, sheetName: b.sheetName, updatedAt: b.updatedAt };
});
