/**
 * Generates docs/openapi.json from the actual route handlers: every route() call carries its auth
 * mode, scope, permissions and Zod schemas, which are converted to JSON Schema here.
 *   npm run openapi
 */
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z, type ZodType } from 'zod';

const ROOT = path.resolve('src/app/api/v1');
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : f === 'route.ts' ? [p] : [];
  });
}

const toSchema = (s?: ZodType) => {
  if (!s) return undefined;
  try {
    return z.toJSONSchema(s, { unrepresentable: 'any', io: 'input' });
  } catch {
    return { type: 'object' };
  }
};

async function main() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const file of walk(ROOT).sort()) {
    const rel = path.relative(ROOT, path.dirname(file)).split(path.sep).join('/');
    const apiPath = `/api/v1/${rel}`.replace(/\[([^\]]+)\]/g, '{$1}').replace(/\/$/, '');
    const mod = await import(pathToFileURL(file).href);
    for (const m of METHODS) {
      const h = mod[m];
      if (!h?.meta) continue;
      const meta = h.meta as { auth: string; scope: string; perms: string[]; selfService: boolean; stepUp: boolean; apiKey: boolean; body?: ZodType; query?: ZodType; rate?: { limit: number; windowSec: number } };
      const params = [...apiPath.matchAll(/\{(\w+)\}/g)].map((x) => ({ name: x[1], in: 'path', required: true, schema: { type: 'string' } }));
      const q = toSchema(meta.query) as { properties?: Record<string, unknown>; required?: string[] } | undefined;
      for (const [name, schema] of Object.entries(q?.properties ?? {})) params.push({ name, in: 'query', required: Boolean(q?.required?.includes(name)), schema: schema as { type: string } });
      const tag = rel.split('/')[0] || 'root';
      paths[apiPath] ??= {};
      paths[apiPath][m.toLowerCase()] = {
        tags: [tag],
        summary: `${m} ${apiPath}`,
        description: [
          meta.auth === 'public' ? 'Public endpoint.' : `Scope: ${meta.scope}.`,
          meta.perms.length ? `Requires any of: ${meta.perms.join(', ')}.` : meta.selfService ? 'Acts on the caller’s own account.' : '',
          meta.stepUp ? 'Requires recent step-up verification.' : '',
          meta.apiKey ? 'Accepts API keys (Bearer lck_…).' : '',
          meta.rate ? `Rate limit: ${meta.rate.limit} per ${meta.rate.windowSec}s.` : '',
        ].filter(Boolean).join(' '),
        'x-permissions': meta.perms,
        'x-scope': meta.scope,
        parameters: params,
        ...(meta.body ? { requestBody: { required: true, content: { 'application/json': { schema: toSchema(meta.body) } } } } : {}),
        security: meta.auth === 'public' ? [] : [{ session: [] }, ...(meta.apiKey ? [{ apiKey: [] }] : [])],
        responses: {
          200: { description: 'Success' },
          401: { $ref: '#/components/responses/Error' }, 403: { $ref: '#/components/responses/Error' },
          404: { $ref: '#/components/responses/Error' }, 422: { $ref: '#/components/responses/Error' }, 429: { $ref: '#/components/responses/Error' },
        },
      };
    }
  }
  const spec = {
    openapi: '3.1.0',
    info: { title: 'markeetor.com API', version: '1.0.0', description: 'Versioned REST API. Cookie sessions for the web app; read-only API keys for platform integrations. All mutations require a same-origin Origin header when cookie-authenticated.' },
    servers: [{ url: '/' }],
    components: {
      securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: 'lc_session' }, apiKey: { type: 'http', scheme: 'bearer' } },
      responses: { Error: { description: 'Error envelope', content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, details: {}, requestId: { type: 'string' } } } } } } } } },
    },
    paths,
  };
  writeFileSync('docs/openapi.json', JSON.stringify(spec, null, 2));
  console.log(`Wrote docs/openapi.json with ${Object.keys(paths).length} paths`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
