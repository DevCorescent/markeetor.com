'use client';
import type { ColumnDef } from '@tanstack/react-table';
import { FileSpreadsheet, Sparkles, Trash2, Upload } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { DataTable } from '@/components/data/data-table';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page';
import { InlineNotice } from '@/components/ui/states';
import { Switch } from '@/components/ui/overlay';
import { useApiMutation } from '@/lib/hooks';
import { api, errorMessage } from '@/lib/api-client';
import { fmtAgo, fmtInt } from '@/lib/format';
import { useApiQuery, useUrlState } from '@/lib/hooks';

type Row = { id: string; draftStep?: string; columns?: number; updatedAt?: string; code: string; fileName: string; fileSize: number; status: string; totalRows: number; insertedCount: number; updatedCount: number; skippedCount: number; invalidCount: number; duplicateCount: number; createdBy: string; createdAt: string; source: string | null; campaign: string | null };

const columns: ColumnDef<Row, unknown>[] = [
  { id: 'file', header: 'File', cell: ({ row: { original: r } }) => <div className="min-w-[200px]"><div className="truncate text-fg">{r.fileName}</div><div className="font-mono text-[11px] text-subtle">{r.code} · {(r.fileSize / 1024).toFixed(0)} KB</div></div> },
  { id: 'status', header: 'Status', cell: ({ row: { original: r } }) => <StatusBadge status={r.status} /> },
  { id: 'rows', header: 'Rows', cell: ({ row: { original: r } }) => <span className="tnum">{fmtInt(r.totalRows)}</span> },
  { id: 'result', header: 'Inserted / updated / skipped / invalid', cell: ({ row: { original: r } }) => <span className="tnum text-muted">{fmtInt(r.insertedCount)} / {fmtInt(r.updatedCount)} / {fmtInt(r.skippedCount)} / <span className={r.invalidCount ? 'text-warn' : ''}>{fmtInt(r.invalidCount)}</span></span> },
  { id: 'attr', header: 'Attribution', cell: ({ row: { original: r } }) => <span className="text-muted">{[r.source, r.campaign].filter(Boolean).join(' · ') || '—'}</span> },
  { id: 'by', header: 'Uploaded', cell: ({ row: { original: r } }) => <span className="text-subtle">{r.createdBy} · {fmtAgo(r.createdAt)}</span> },
];

export function ImportCenter({ canCreate }: { canCreate: boolean }) {
  const router = useRouter();
  const [s, set] = useUrlState({ page: '1' });
  const { data, isFetching, error } = useApiQuery<{ total: number; rows: Row[] }>(`/api/v1/imports?page=${s.page}&pageSize=20`, { refetchInterval: 10_000 });
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [auto, setAuto] = useState(() => { try { return localStorage.getItem('lcrm.import.auto') === '1'; } catch { return false; } });
  const drafts = useApiQuery<{ total: number; rows: Row[] }>('/api/v1/imports?drafts=1&pageSize=10');
  const discard = useApiMutation((id: string) => api(`/api/v1/imports/${id}/cancel`, { method: 'POST' }), { success: 'Draft discarded', invalidate: ['/api/v1/imports'] });

  const upload = async (file: File) => {
    setBusy(true);
    setErr(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      if (auto) fd.append('auto', '1');
      const res = await api<{ import: { id: string }; auto: { started: boolean; problems: string[] } | null }>('/api/v1/imports', { body: fd });
      if (res.auto && !res.auto.started) setErr(`Auto-import needs a quick review: ${res.auto.problems.join('; ')}`);
      router.push(`/admin/imports/${res.import.id}`);
    } catch (e) {
      setErr(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Import center" description="Upload CSV or XLSX lead files. Every file is validated, normalized and previewed before anything is written." actions={canCreate && (
        // eslint-disable-next-line @next/next/no-html-link-for-pages -- API file download, not a page
        <a href="/api/v1/imports/sample" className="text-xs text-subtle hover:text-fg">Download column template</a>
      )} />
      {canCreate && (
        <Card
          className={`mb-5 border-dashed transition-colors ${drag ? 'border-fg/60 bg-surface-2' : 'border-border-strong'}`}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) upload(f); }}
        >
          <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
            <div className="grid size-10 place-items-center rounded-md border border-border-strong bg-surface-2"><FileSpreadsheet className="size-4 text-muted" /></div>
            <div>
              <p className="text-[13px] font-medium">Drop a lead file here</p>
              <p className="mt-1 text-xs text-subtle">.csv, .tsv, .txt or .xlsx — up to 25 MB and 200,000 rows. Formulas are never evaluated.</p>
            </div>
            <input ref={input} type="file" accept=".csv,.tsv,.txt,.xlsx,text/csv,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} />
            <Button variant="primary" loading={busy} onClick={() => input.current?.click()}><Upload /> Choose file</Button>
            <label className="mt-1 flex items-center gap-2.5 rounded-full border border-border px-3 py-1.5 text-[12px] text-muted">
              <Sparkles className="size-3.5" />
              <span>Smart auto-import <span className="text-subtle">— map columns automatically and import when the data is clean</span></span>
              <Switch checked={auto} onCheckedChange={(v) => { setAuto(v); try { localStorage.setItem('lcrm.import.auto', v ? '1' : '0'); } catch {} }} aria-label="Smart auto-import" />
            </label>
            <p className="text-[11px] text-subtle">Any layout works: we detect delimiters, encodings, the header row, the best worksheet and which column is which.</p>
            {err && <InlineNotice tone="danger">{err}</InlineNotice>}
          </div>
        </Card>
      )}
      {canCreate && (drafts.data?.rows.length ?? 0) > 0 && (
        <Card className="mb-5">
          <div className="border-b border-border px-4 py-2.5"><span className="text-[13px] font-medium">Drafts</span><span className="ml-2 text-xs text-subtle">Unfinished imports are saved automatically — pick up where you left off.</span></div>
          <ul>
            {drafts.data!.rows.map((d) => (
              <li key={d.id} className="flex items-center gap-3 border-b border-border/60 px-4 py-2.5 last:border-0">
                <FileSpreadsheet className="size-4 text-subtle" />
                <div className="min-w-0 flex-1"><div className="truncate text-[12.5px]">{d.fileName}</div><div className="text-[11px] text-subtle">{d.code} · {d.columns ?? '—'} columns · step: {d.status === 'PREVIEW_READY' ? 'review' : d.status === 'VALIDATING' ? 'validating' : d.draftStep} · saved {fmtAgo(d.updatedAt ?? d.createdAt)}</div></div>
                <Button size="sm" variant="primary" onClick={() => router.push(`/admin/imports/${d.id}`)}>Resume</Button>
                {d.status !== 'VALIDATING' && <Button size="icon" variant="ghost" aria-label="Discard draft" onClick={() => discard.mutate(d.id)}><Trash2 /></Button>}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <DataTable columns={columns} data={data?.rows ?? []} total={data?.total ?? 0} page={Number(s.page)} pageSize={20} onPage={(p) => set({ page: String(p) })} loading={isFetching} error={error ? errorMessage(error) : null} getRowId={(r) => r.id} onRowClick={(r) => router.push(`/admin/imports/${r.id}`)} />
    </>
  );
}
