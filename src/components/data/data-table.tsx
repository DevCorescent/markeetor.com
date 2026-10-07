'use client';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef, type VisibilityState } from '@tanstack/react-table';
import { ArrowDown, ArrowUp, Columns3 } from 'lucide-react';
import { useMemo } from 'react';
import { cn } from '@/lib/cn';
import { fmtInt } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Checkbox, Popover, PopoverContent, PopoverTrigger } from '@/components/ui/overlay';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/states';
import { Pagination } from '@/components/ui/table-bits';

export type SelectionState = { all: boolean; ids: Set<string>; excluded: Set<string> };
export const emptySelection = (): SelectionState => ({ all: false, ids: new Set(), excluded: new Set() });
export const selectionCount = (s: SelectionState, total: number) => (s.all ? total - s.excluded.size : s.ids.size);
export const isSelected = (s: SelectionState, id: string) => (s.all ? !s.excluded.has(id) : s.ids.has(id));

/** Phone card layout (globals.css): each cell carries its column label; the first labelled column is the card title. */
const headerLabel = (h: unknown) => (typeof h === 'string' ? h : '');
function cellAttrs(id: string, header: unknown, primaryId: string | undefined) {
  const label = headerLabel(header);
  return { 'data-label': label || undefined, 'data-primary': id === primaryId ? '' : undefined, 'data-select': id === '__select' ? '' : undefined };
}

type Props<T> = {
  columns: ColumnDef<T, any>[];
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  onPage: (p: number) => void;
  sort?: { id: string; desc: boolean } | null;
  onSort?: (s: { id: string; desc: boolean } | null) => void;
  loading?: boolean;
  error?: string | null;
  getRowId: (row: T) => string;
  selection?: SelectionState;
  onSelection?: (s: SelectionState) => void;
  columnVisibility?: VisibilityState;
  onColumnVisibility?: (v: VisibilityState) => void;
  onRowClick?: (row: T) => void;
  empty?: React.ReactNode;
  toolbar?: React.ReactNode;
  dense?: boolean;
};

export function DataTable<T>({ columns, data, total, page, pageSize, onPage, sort, onSort, loading, error, getRowId, selection, onSelection, columnVisibility, onColumnVisibility, onRowClick, empty, toolbar, dense }: Props<T>) {
  const selectable = Boolean(selection && onSelection);
  const pageIds = useMemo(() => data.map(getRowId), [data, getRowId]);
  const pageSelected = selectable ? pageIds.filter((id) => isSelected(selection!, id)).length : 0;
  const headerState: boolean | 'indeterminate' = pageSelected === 0 ? false : pageSelected === pageIds.length ? true : 'indeterminate';

  const allColumns = useMemo<ColumnDef<T, any>[]>(() => {
    if (!selectable) return columns;
    return [
      {
        id: '__select',
        size: 32,
        enableHiding: false,
        enableSorting: false,
        header: () => (
          <Checkbox
            aria-label="Select page"
            checked={headerState}
            onCheckedChange={(v) => {
              const s = selection!;
              if (s.all) {
                const excluded = new Set(s.excluded);
                pageIds.forEach((id) => (v ? excluded.delete(id) : excluded.add(id)));
                onSelection!({ ...s, excluded });
              } else {
                const ids = new Set(s.ids);
                pageIds.forEach((id) => (v ? ids.add(id) : ids.delete(id)));
                onSelection!({ ...s, ids });
              }
            }}
          />
        ),
        cell: ({ row }) => {
          const id = getRowId(row.original);
          return (
            <span onClick={(e) => e.stopPropagation()}>
              <Checkbox
                aria-label="Select row"
                checked={isSelected(selection!, id)}
                onCheckedChange={(v) => {
                  const s = selection!;
                  if (s.all) {
                    const excluded = new Set(s.excluded);
                    v ? excluded.delete(id) : excluded.add(id);
                    onSelection!({ ...s, excluded });
                  } else {
                    const ids = new Set(s.ids);
                    v ? ids.add(id) : ids.delete(id);
                    onSelection!({ ...s, ids });
                  }
                }}
              />
            </span>
          );
        },
      },
      ...columns,
    ];
  }, [columns, selectable, selection, onSelection, headerState, pageIds, getRowId]);

  const table = useReactTable({
    data,
    columns: allColumns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    state: { columnVisibility: columnVisibility ?? {} },
    onColumnVisibilityChange: (u) => onColumnVisibility?.(typeof u === 'function' ? u(columnVisibility ?? {}) : u),
    getRowId: (r) => getRowId(r),
  });

  const primaryId = table.getVisibleLeafColumns().find((c) => headerLabel(c.columnDef.header))?.id;
  const count = selectable ? selectionCount(selection!, total) : 0;
  const showSelectAllBanner = selectable && !selection!.all && pageSelected === pageIds.length && pageIds.length > 0 && total > pageIds.length;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      {(toolbar || onColumnVisibility) && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{toolbar}</div>
          {onColumnVisibility && (
            <Popover>
              <PopoverTrigger asChild>
                <Button size="sm" variant="ghost"><Columns3 /> Columns</Button>
              </PopoverTrigger>
              <PopoverContent className="w-52 p-1.5">
                {table.getAllLeafColumns().filter((c) => c.getCanHide()).map((c) => (
                  <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12.5px] hover:bg-surface-3">
                    <Checkbox checked={c.getIsVisible()} onCheckedChange={(v) => c.toggleVisibility(v)} aria-label={`Toggle ${c.id}`} />
                    {typeof c.columnDef.header === 'string' ? c.columnDef.header : c.id}
                  </label>
                ))}
              </PopoverContent>
            </Popover>
          )}
        </div>
      )}
      {selectable && count > 0 && (
        <div className="flex flex-wrap items-center gap-3 border-b border-border bg-surface-2 px-3 py-1.5 text-xs">
          <span className="tnum text-fg">{fmtInt(count)} selected{selection!.all ? ' (all matching results)' : ''}</span>
          {showSelectAllBanner && (
            <button className="text-fg-2 underline underline-offset-2 hover:text-fg" onClick={() => onSelection!({ all: true, ids: new Set(), excluded: new Set() })}>
              Select all {fmtInt(total)} matching results
            </button>
          )}
          <button className="text-subtle hover:text-fg" onClick={() => onSelection!(emptySelection())}>Clear selection</button>
        </div>
      )}
      <div className="overflow-x-auto">
        <table data-rt="" className="w-full border-collapse text-[12.5px]">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} className="border-b border-border">
                {hg.headers.map((h) => {
                  const sortable = onSort && h.column.columnDef.enableSorting !== false && h.column.id !== '__select';
                  const active = sort?.id === h.column.id;
                  return (
                    <th
                      key={h.id}
                      style={{ width: h.column.columnDef.size && h.column.id === '__select' ? h.column.columnDef.size : undefined }}
                      className={cn('h-8 px-3 text-left text-[10.5px] font-medium uppercase tracking-[0.08em] whitespace-nowrap', active ? 'text-fg-2' : 'text-subtle')}
                      aria-sort={active ? (sort!.desc ? 'descending' : 'ascending') : undefined}
                    >
                      {h.isPlaceholder ? null : sortable ? (
                        <button
                          className="inline-flex items-center gap-1 uppercase hover:text-fg"
                          onClick={() => onSort!(active ? (sort!.desc ? null : { id: h.column.id, desc: true }) : { id: h.column.id, desc: false })}
                        >
                          {flexRender(h.column.columnDef.header, h.getContext())}
                          {active && (sort!.desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
                        </button>
                      ) : (
                        flexRender(h.column.columnDef.header, h.getContext())
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {loading && data.length === 0 ? (
              Array.from({ length: 8 }).map((_, i) => (
                <tr key={i} className="border-b border-border/70">
                  {table.getVisibleLeafColumns().map((c) => (
                    <td key={c.id} {...cellAttrs(c.id, c.columnDef.header, primaryId)} className="h-10 px-3"><Skeleton className="h-3 w-full max-w-[140px]" /></td>
                  ))}
                </tr>
              ))
            ) : error ? (
              <tr><td colSpan={table.getVisibleLeafColumns().length}><ErrorState description={error} /></td></tr>
            ) : data.length === 0 ? (
              <tr><td colSpan={table.getVisibleLeafColumns().length}>{empty ?? <EmptyState title="No results" description="Try adjusting your filters." />}</td></tr>
            ) : (
              table.getRowModel().rows.map((row) => {
                const sel = selectable && isSelected(selection!, row.id);
                return (
                  <tr
                    key={row.id}
                    onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                    className={cn('border-b border-border/70 transition-colors last:border-0', onRowClick && 'cursor-pointer hover:bg-surface-2', sel && 'bg-surface-2', loading && 'opacity-60')}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} {...cellAttrs(cell.column.id, cell.column.columnDef.header, primaryId)} className={cn('px-3 text-fg-2 whitespace-nowrap', dense ? 'h-8' : 'h-10')}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <Pagination page={page} pageSize={pageSize} total={total} onPage={onPage} />
    </div>
  );
}
