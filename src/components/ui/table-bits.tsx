'use client';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import { fmtInt } from '@/lib/format';
import { Button } from './button';

export function Pagination({ page, pageSize, total, onPage, className }: { page: number; pageSize: number; total: number; onPage: (p: number) => void; className?: string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className={cn('flex items-center justify-between gap-3 border-t border-border px-3 py-2 text-xs text-subtle', className)}>
      <span className="tnum">{fmtInt(from)}–{fmtInt(to)} of {fmtInt(total)}</span>
      <div className="flex items-center gap-1">
        <span className="tnum mr-2 hidden sm:inline">Page {page} / {pages}</span><span className="tnum mr-1 sm:hidden">{page}/{pages}</span>
        <Button size="icon" variant="ghost" className="max-sm:size-9" aria-label="Previous page" disabled={page <= 1} onClick={() => onPage(page - 1)}><ChevronLeft /></Button>
        <Button size="icon" variant="ghost" className="max-sm:size-9" aria-label="Next page" disabled={page >= pages} onClick={() => onPage(page + 1)}><ChevronRight /></Button>
      </div>
    </div>
  );
}
