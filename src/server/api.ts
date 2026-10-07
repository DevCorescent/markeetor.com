import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { z, ZodError, type ZodType } from 'zod';
import type { PermissionKey, Scope } from '@/lib/permissions';
import { auditDetached } from './audit';
import { authenticateApiKey } from './auth/apikeys';
import { contextFromToken, requireStepUp, type AuthContext, type RequestMeta } from './auth/context';
import { readCookie, SESSION_COOKIE } from './auth/session';
import { AppError } from './errors';
import { logger } from './logger';
import { rateLimit } from './ratelimit';
import { onForbidden } from './security/alerts';
import { getSetting } from './settings';

type Auth =
  /** Fully authenticated, MFA complete, no outstanding restriction. */
  | 'required'
  /** Authenticated session, even if MFA verification/enrollment is still outstanding (MFA endpoints only). */
  | 'session-any'
  | 'public';

export type RouteOptions<B extends ZodType | undefined, Q extends ZodType | undefined> = {
  auth?: Auth;
  /** Which portal may call this endpoint. Defaults to PLATFORM — deny by default. */
  scope?: Scope | 'ANY';
  /** Any-of permission list. Required for authenticated routes unless `selfService` is set. */
  perm?: PermissionKey | PermissionKey[];
  /** Endpoints acting only on the caller's own account (profile, MFA, notifications). */
  selfService?: boolean;
  /** Still callable while the user must replace an emailed temporary password (the password change itself). */
  allowPasswordChangeRestriction?: boolean;
  body?: B;
  query?: Q;
  stepUp?: boolean;
  /** Allow API-key authentication for this route. */
  apiKey?: boolean;
  rate?: { bucket: string; limit: number; windowSec: number; by?: 'user' | 'ip' | 'org' };
};

type Infer<T> = T extends ZodType ? z.infer<T> : undefined;

export type Handler<B, Q, A extends Auth> = (args: {
  req: Request;
  ctx: A extends 'public' ? AuthContext | null : AuthContext;
  meta: RequestMeta;
  body: B;
  query: Q;
  params: Record<string, string>;
}) => Promise<Response | unknown>;

export function requestMeta(req: Request): RequestMeta {
  const fwd = req.headers.get('x-forwarded-for');
  // Without a trusted proxy we take the right-most hop (appended by our own server), which clients cannot forge.
  const hops = fwd?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
  const ip = (process.env.TRUST_PROXY === 'true' ? hops[0] : hops[hops.length - 1]) ?? req.headers.get('x-real-ip') ?? null;
  return {
    requestId: req.headers.get('x-request-id')?.slice(0, 64) || randomUUID(),
    ip,
    userAgent: req.headers.get('user-agent'),
  };
}

export function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(init.headers ?? {}) },
  });
}

export function errorResponse(err: AppError, requestId: string) {
  return json({ error: { code: err.code, message: err.message, details: err.details ?? undefined, requestId } }, { status: err.status, headers: { 'x-request-id': requestId } });
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** CSRF defence for cookie-authenticated mutations: require a same-origin Origin (or Referer) header. */
function checkOrigin(req: Request) {
  if (!MUTATING.has(req.method)) return;
  const allowed = new Set<string>();
  try {
    allowed.add(new URL(process.env.APP_URL ?? 'http://localhost:3000').origin);
  } catch {}
  const host = req.headers.get('host');
  if (host) {
    allowed.add(`http://${host}`);
    allowed.add(`https://${host}`);
  }
  const origin = req.headers.get('origin');
  if (origin) {
    if (!allowed.has(origin)) throw new AppError('FORBIDDEN', 'Cross-origin request rejected');
    return;
  }
  const referer = req.headers.get('referer');
  if (referer) {
    try {
      if (allowed.has(new URL(referer).origin)) return;
    } catch {}
  }
  throw new AppError('FORBIDDEN', 'Missing request origin');
}

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) {
    return new AppError('VALIDATION_FAILED', 'Some fields are invalid', err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') return new AppError('CONFLICT', 'A record with these details already exists', { fields: err.meta?.target });
    if (err.code === 'P2025') return new AppError('NOT_FOUND', 'Record not found');
    if (err.code === 'P2028') return new AppError('INTERNAL', 'The operation timed out. Please retry.');
  }
  return new AppError('INTERNAL', 'Something went wrong. The error has been logged.');
}

/**
 * Wraps a route handler with: request id, authentication (session cookie or API key), MFA state checks,
 * CSRF origin checks, rate limiting, scope + permission authorization (deny by default), input validation,
 * consistent errors, and denial auditing.
 */
export function route<B extends ZodType | undefined = undefined, Q extends ZodType | undefined = undefined, A extends Auth = 'required'>(
  opts: RouteOptions<B, Q> & { auth?: A },
  handler: Handler<Infer<B>, Infer<Q>, A>,
) {
  const auth: Auth = opts.auth ?? 'required';
  const scope = opts.scope ?? 'PLATFORM';
  const perms = opts.perm ? (Array.isArray(opts.perm) ? opts.perm : [opts.perm]) : [];
  if (auth !== 'public' && !perms.length && !opts.selfService) {
    throw new Error('route(): authenticated routes must declare `perm` or `selfService`');
  }

  const fn = async (req: Request, routeCtx?: { params?: Promise<Record<string, string | string[]>> }) => {
    const meta = requestMeta(req);
    const started = Date.now();
    const url = new URL(req.url);
    let ctx: AuthContext | null = null;
    try {
      const rawParams = (await routeCtx?.params) ?? {};
      const params = Object.fromEntries(Object.entries(rawParams).map(([k, v]) => [k, Array.isArray(v) ? v.join('/') : v]));

      const bearer = req.headers.get('authorization');
      if (bearer?.startsWith('Bearer ')) {
        if (!opts.apiKey) throw new AppError('UNAUTHENTICATED', 'API keys are not accepted on this endpoint');
        ctx = await authenticateApiKey(bearer.slice(7).trim(), meta);
        if (!ctx) throw new AppError('UNAUTHENTICATED', 'Invalid API key');
      } else if (auth !== 'public' || readCookie(req.headers.get('cookie'), SESSION_COOKIE)) {
        const resolved = await contextFromToken(readCookie(req.headers.get('cookie'), SESSION_COOKIE), meta).catch((e) => {
          if (auth === 'public') return null;
          throw e;
        });
        ctx = resolved?.ctx ?? null;
        if (auth !== 'public' && !ctx) throw new AppError('UNAUTHENTICATED', 'Please sign in');
      }
      // Cookie-authenticated (or anonymous) mutations must come from our own origin.
      if (!bearer?.startsWith('Bearer ')) checkOrigin(req);

      if (auth === 'required' && ctx?.session) {
        if (ctx.session.mfaPending) throw new AppError('MFA_REQUIRED', 'Two-factor verification required');
        if (ctx.restriction === 'PASSWORD_CHANGE_REQUIRED' && !opts.allowPasswordChangeRestriction) throw new AppError('PASSWORD_CHANGE_REQUIRED', 'Choose a new password to continue');
        if (ctx.restriction === 'MFA_ENROLLMENT_REQUIRED') throw new AppError('MFA_ENROLLMENT_REQUIRED', 'Set up two-factor authentication to continue');
      }

      if (ctx && auth !== 'public') {
        if (scope !== 'ANY' && ctx.scope !== scope) throw new AppError('FORBIDDEN', 'This endpoint is not available for your account type');
        if (perms.length && !perms.some((p) => ctx!.permissions.has(p))) {
          throw new AppError('FORBIDDEN', 'You do not have permission to perform this action', { required: perms });
        }
        if (opts.stepUp) await requireStepUp(ctx);
      }

      // Rate limits: a global per-user ceiling plus optional per-route buckets.
      if (ctx) {
        const policy = await getSetting('security.policy');
        const g = await rateLimit(`api:user:${ctx.user.id}`, policy.apiRequestsPerMinute, 60);
        if (!g.ok) throw new AppError('RATE_LIMITED', 'Too many requests. Please slow down.', { retryAfterSec: g.resetSec });
      }
      if (opts.rate) {
        const by = opts.rate.by ?? (ctx ? 'user' : 'ip');
        const id = by === 'user' ? ctx?.user.id : by === 'org' ? ctx?.orgId : meta.ip;
        const r = await rateLimit(`${opts.rate.bucket}:${by}:${id ?? 'anon'}`, opts.rate.limit, opts.rate.windowSec);
        if (!r.ok) throw new AppError('RATE_LIMITED', 'Too many requests. Please try again later.', { retryAfterSec: r.resetSec });
      }

      let body: unknown = undefined;
      if (opts.body) {
        const ct = req.headers.get('content-type') ?? '';
        if (!ct.includes('application/json')) throw new AppError('UNSUPPORTED_MEDIA', 'Expected application/json');
        const text = await req.text();
        if (text.length > 2_000_000) throw new AppError('PAYLOAD_TOO_LARGE', 'Request body too large');
        let parsed: unknown;
        try {
          parsed = text ? JSON.parse(text) : {};
        } catch {
          throw new AppError('BAD_REQUEST', 'Malformed JSON');
        }
        body = opts.body.parse(parsed);
      }
      let query: unknown = undefined;
      if (opts.query) {
        const q: Record<string, string | string[]> = {};
        for (const key of new Set(url.searchParams.keys())) {
          const all = url.searchParams.getAll(key);
          q[key] = all.length > 1 ? all : all[0];
        }
        query = opts.query.parse(q);
      }

      const result = await handler({
        req,
        ctx: ctx as AuthContext,
        meta,
        body: body as Infer<B>,
        query: query as Infer<Q>,
        params,
      });
      const res = result instanceof Response ? result : json(result ?? { ok: true });
      res.headers.set('x-request-id', meta.requestId);
      logger.debug({ requestId: meta.requestId, method: req.method, path: url.pathname, status: res.status, ms: Date.now() - started, userId: ctx?.user.id }, 'request');
      return res;
    } catch (err) {
      const appErr = toAppError(err);
      if (appErr.code === 'INTERNAL') {
        logger.error({ err, requestId: meta.requestId, path: url.pathname, userId: ctx?.user.id }, 'unhandled API error');
      } else {
        logger.info({ requestId: meta.requestId, path: url.pathname, code: appErr.code, userId: ctx?.user.id }, 'request rejected');
      }
      if (appErr.code === 'FORBIDDEN' && ctx) {
        await auditDetached(ctx, {
          action: 'access.denied',
          result: 'DENIED',
          targetType: 'endpoint',
          targetId: `${req.method} ${url.pathname}`,
          reason: appErr.message,
        });
        await onForbidden(ctx.user.id, ctx.orgId, ctx.ip, url.pathname).catch(() => null);
      }
      return errorResponse(appErr, meta.requestId);
    }
  };
  // Exposed for OpenAPI generation (scripts/openapi.ts); never used for authorization.
  return Object.assign(fn, { meta: { auth, scope, perms, selfService: Boolean(opts.selfService), stepUp: Boolean(opts.stepUp), apiKey: Boolean(opts.apiKey), body: opts.body, query: opts.query, rate: opts.rate } });
}

// ── Shared query helpers ────────────────────────────────────────────

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

export const idParam = (params: Record<string, string>, key = 'id') => {
  const v = params[key];
  if (!v || v.length > 64 || !/^[a-zA-Z0-9_-]+$/.test(v)) throw new AppError('NOT_FOUND', 'Record not found');
  return v;
};
