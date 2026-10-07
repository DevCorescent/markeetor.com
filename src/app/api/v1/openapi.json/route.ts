import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { route } from '@/server/api';
import { AppError } from '@/server/errors';

export const GET = route({ selfService: true, scope: 'PLATFORM' }, async () => {
  try {
    const raw = await readFile(path.resolve('docs/openapi.json'), 'utf8');
    return new Response(raw, { headers: { 'content-type': 'application/json', 'cache-control': 'private, max-age=60' } });
  } catch {
    throw new AppError('NOT_FOUND', 'OpenAPI document not generated. Run `npm run openapi`.');
  }
});
