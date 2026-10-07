'use client';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown, public requestId?: string) {
    super(message);
  }
}

type StepUpHandler = () => Promise<boolean>;
let stepUpHandler: StepUpHandler | null = null;
export function registerStepUpHandler(fn: StepUpHandler | null) {
  stepUpHandler = fn;
}

type Opts = { method?: string; body?: unknown; signal?: AbortSignal; raw?: boolean };

/**
 * Hard-navigates to a recovery page, unless we are already on it.
 *
 * The guard is what stops a reload loop: pages such as /account/mfa-setup still render the
 * app shell, whose notification poll calls an `auth: 'required'` endpoint. For a user who has
 * not enrolled yet that returns MFA_ENROLLMENT_REQUIRED, and redirecting to the page we are
 * already on would reload it, re-poll, and redirect again — forever, with the page visibly
 * flickering and any in-flight request (the enrollment QR) aborted before it can render.
 */
function navigate(to: string) {
  if (typeof window === 'undefined') return;
  const target = new URL(to, window.location.origin);
  if (target.pathname === window.location.pathname) return;
  window.location.href = to;
}

/**
 * Same-origin JSON fetch. On STEP_UP_REQUIRED it asks the global step-up dialog to re-verify the user,
 * then retries once. On session expiry it sends the user back to sign in.
 */
export async function api<T = unknown>(path: string, opts: Opts = {}, retried = false): Promise<T> {
  const isForm = typeof FormData !== 'undefined' && opts.body instanceof FormData;
  const res = await fetch(path, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: opts.body && !isForm ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? (isForm ? (opts.body as FormData) : JSON.stringify(opts.body)) : undefined,
    signal: opts.signal,
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (res.ok) {
    if (opts.raw) return res as unknown as T;
    const ct = res.headers.get('content-type') ?? '';
    return (ct.includes('application/json') ? await res.json() : await res.text()) as T;
  }
  let payload: { error?: { code: string; message: string; details?: unknown; requestId?: string } } = {};
  try {
    payload = await res.json();
  } catch {}
  const e = payload.error ?? { code: 'INTERNAL', message: `Request failed (${res.status})` };
  if (e.code === 'STEP_UP_REQUIRED' && !retried && stepUpHandler) {
    if (await stepUpHandler()) return api<T>(path, opts, true);
  }
  if (e.code === 'UNAUTHENTICATED' && !path.includes('/auth/')) {
    navigate(`/login?next=${encodeURIComponent(typeof window === 'undefined' ? '/' : window.location.pathname)}`);
  }
  if (e.code === 'MFA_ENROLLMENT_REQUIRED') navigate('/account/mfa-setup');
  if (e.code === 'PASSWORD_CHANGE_REQUIRED') navigate('/account/change-password');
  throw new ApiError(res.status, e.code, e.message, e.details, e.requestId);
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'VALIDATION_FAILED' && Array.isArray(err.details) && err.details.length) {
      const first = err.details[0] as { path?: string; message?: string } | string;
      if (typeof first === 'string') return first;
      return first.path ? `${first.path}: ${first.message}` : (first.message ?? err.message);
    }
    return err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong';
}

export function qs(params: Record<string, unknown>) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach((x) => sp.append(k, String(x)));
    else sp.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}
