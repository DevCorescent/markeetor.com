import { cn } from '@/lib/cn';

/** Simple static table for small, already-bounded datasets (server paginated lists use DataTable). */
export function SimpleTable({ columns, rows, empty, className, onRowClick }: {
  columns: { key: string; header: React.ReactNode; className?: string; render?: (row: any) => React.ReactNode }[];
  rows: any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  empty?: React.ReactNode;
  className?: string;
  onRowClick?: (row: any) => void;
}) {
  const primary = columns.find((c) => typeof c.header === 'string' && c.header)?.key;
  return (
    <div className={cn('overflow-x-auto', className)}>
      <table data-rt="" className="w-full border-collapse text-[12.5px]">
        <thead>
          <tr className="border-b border-border">
            {columns.map((c) => (
              <th key={c.key} className={cn('h-8 px-3 text-left text-[10.5px] font-medium uppercase tracking-[0.08em] text-subtle whitespace-nowrap', c.className)}>{c.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={columns.length}>{empty ?? <div className="py-8 text-center text-xs text-subtle">Nothing to show</div>}</td></tr>
          ) : (
            rows.map((r, i) => (
              <tr key={r.id ?? i} onClick={onRowClick ? () => onRowClick(r) : undefined} className={cn('border-b border-border/70 last:border-0', onRowClick && 'cursor-pointer hover:bg-surface-2')}>
                {columns.map((c) => (
                  <td key={c.key} data-label={typeof c.header === 'string' && c.header ? c.header : undefined} data-primary={c.key === primary ? '' : undefined} className={cn('h-9 px-3 text-fg-2', c.className)}>{c.render ? c.render(r) : (r[c.key] ?? '—')}</td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
