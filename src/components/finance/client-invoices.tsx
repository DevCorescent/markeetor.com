'use client';
import { FileText } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Card, CardHeader } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import { fmtDate } from '@/lib/format';
import { useApiQuery } from '@/lib/hooks';
import { money } from '@/lib/pricing';
import { TaxInvoiceDialog, type TaxInvoice } from './tax-invoice';

/** The workspace's GST tax invoices (credit purchases and invoiced lead purchases). */
export function ClientTaxInvoices({ canEditTax }: { canEditTax?: boolean }) {
  const { data } = useApiQuery<{ total: number; rows: TaxInvoice[] }>('/api/v1/finance/invoices?page=1&pageSize=50');
  const [open, setOpen] = useState<string | null>(null);
  if (!data) return null;
  const noGst = data.rows.length > 0 && !data.rows[0].buyer.gstin;
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><FileText className="size-4 text-accent" />Tax invoices</span>} description="GST invoices for your purchases — open one to print or save as PDF." />
      {noGst && canEditTax && <div className="mx-4 mb-2 rounded-md bg-info-dim px-3 py-2 text-[12px] text-info">Add your GSTIN in <Link href="/app/settings?tab=general" className="font-medium underline">Settings → General</Link> to claim input tax credit on future invoices.</div>}
      <ul className="flex flex-col divide-y divide-border">
        {data.rows.map((i) => (
          <li key={i.id}>
            <button type="button" onClick={() => setOpen(i.id)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[12.5px] hover:bg-surface-2">
              <span className="font-mono text-[11.5px]">{i.number}</span>
              <span className="text-subtle">{fmtDate(i.issuedAt)}</span>
              <span className="min-w-0 flex-1 truncate text-muted">{i.kind === 'CREDIT_PURCHASE' ? 'Credit purchase' : 'Lead purchase'}</span>
              <span className={cn('rounded-full px-2 py-0.5 text-[10.5px] font-medium', i.paid ? 'bg-ok-dim text-ok' : 'bg-warn-dim text-warn')}>{i.paid ? 'Paid' : 'Due'}</span>
              <span className="tnum w-24 text-right font-medium">{money(Math.round(i.total * 100), i.currency)}</span>
            </button>
          </li>
        ))}
        {!data.rows.length && <li className="px-4 py-8 text-center text-[12.5px] text-subtle">No tax invoices yet.</li>}
      </ul>
      {open && <TaxInvoiceDialog id={open} onClose={() => setOpen(null)} />}
    </Card>
  );
}
