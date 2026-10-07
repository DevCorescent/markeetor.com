'use client';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import { api, errorMessage } from './api-client';

export function useApiQuery<T>(url: string | null, opts: { refetchInterval?: number } = {}) {
  return useQuery<T>({
    queryKey: [url],
    queryFn: ({ signal }) => api<T>(url!, { signal }),
    enabled: Boolean(url),
    placeholderData: keepPreviousData,
    refetchInterval: opts.refetchInterval,
    retry: (count, err) => count < 1 && !(err instanceof Error && /40[134]/.test(String((err as { status?: number }).status))),
  });
}

/** Mutation helper: runs the request, toasts success/failure, and invalidates queries by URL prefix. */
export function useApiMutation<TBody, TRes = unknown>(fn: (body: TBody) => Promise<TRes>, opts: { success?: string | ((r: TRes) => string); invalidate?: string[]; onSuccess?: (r: TRes) => void } = {}) {
  const qc = useQueryClient();
  return useMutation<TRes, Error, TBody>({
    mutationFn: fn,
    onSuccess: (res) => {
      if (opts.success) toast.success(typeof opts.success === 'function' ? opts.success(res) : opts.success);
      for (const prefix of opts.invalidate ?? []) qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0] ?? '').startsWith(prefix) });
      opts.onSuccess?.(res);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

/** Keeps view state (filters, page, sort) in the URL so views are shareable and survive reloads. */
export function useUrlState<T extends Record<string, string | undefined>>(defaults: T) {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const state = useMemo(() => {
    const out: Record<string, string | undefined> = { ...defaults };
    for (const k of Object.keys(defaults)) {
      const v = sp.get(k);
      if (v !== null) out[k] = v;
    }
    return out as T;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sp]);
  const set = useCallback(
    (patch: Partial<T>) => {
      const next = new URLSearchParams(sp.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || v === '' || v === defaults[k]) next.delete(k);
        else next.set(k, String(v));
      }
      const q = next.toString();
      router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sp, pathname, router],
  );
  return [state, set] as const;
}
