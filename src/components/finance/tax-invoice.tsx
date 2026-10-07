'use client';
import { Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/overlay';
import { fmtDate } from '@/lib/format';
import { useApiQuery } from '@/lib/hooks';
import { money } from '@/lib/pricing';

export type TaxInvoice = {
  id: string; number: string; fy: string; kind: string; refId: string; organizationId: string; issuedAt: string; currency: string; paid: boolean;
  seller: { legalName: string; gstin: string; pan: string; address: string; state: string; email: string; phone: string };
  buyer: { name: string; gstin: string | null; state: string | null; address: string | null; email: string | null; code: string };
  lines: { description: string; sac: string; qty: number; unitCents: number; amountCents: number }[];
  taxable: number; cgst: number; sgst: number; igst: number; total: number;
};

const words = (n: number) => {
  const a = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two = (x: number) => (x < 20 ? a[x] : `${b[Math.floor(x / 10)]}${x % 10 ? ` ${a[x % 10]}` : ''}`);
  const three = (x: number) => `${x >= 100 ? `${a[Math.floor(x / 100)]} Hundred${x % 100 ? ' ' : ''}` : ''}${x % 100 ? two(x % 100) : ''}`;
  if (n === 0) return 'Zero';
  const parts: string[] = [];
  const crore = Math.floor(n / 1e7), lakh = Math.floor((n % 1e7) / 1e5), thousand = Math.floor((n % 1e5) / 1e3), rest = n % 1e3;
  if (crore) parts.push(`${three(crore)} Crore`);
  if (lakh) parts.push(`${two(lakh)} Lakh`);
  if (thousand) parts.push(`${two(thousand)} Thousand`);
  if (rest) parts.push(three(rest));
  return parts.join(' ');
};

/** Printable GST tax invoice (always light, for paper / PDF). */
export function TaxInvoiceView({ inv }: { inv: TaxInvoice }) {
  const tax = inv.cgst + inv.sgst + inv.igst;
  const rate = inv.taxable ? Math.round((tax / inv.taxable) * 1000) / 10 : 0;
  const rupees = Math.floor(inv.total), paise = Math.round((inv.total - rupees) * 100);
  return (
    <div data-theme="light" className="print-area rounded-lg border border-[#e8e8e4] bg-white p-6 text-[12px] leading-relaxed text-[#0b0b0b]">
      <div className="flex items-start justify-between gap-6 border-b border-[#0b0b0b] pb-4">
        <div>
          <div className="text-[20px] font-semibold tracking-[-0.02em]">Tax Invoice</div>
          <div className="font-mono text-[12px] text-[#5b5b57]">{inv.number}</div>
          {inv.paid ? <span className="mt-1 inline-block rounded border border-[#137a3a] px-1.5 text-[10.5px] font-semibold text-[#137a3a]">PAID</span> : <span className="mt-1 inline-block rounded border border-[#9a6400] px-1.5 text-[10.5px] font-semibold text-[#9a6400]">PAYMENT DUE</span>}
        </div>
        <div className="text-right">
          <div className="text-[14px] font-semibold">{inv.seller.legalName || '—'}</div>
          {inv.seller.address && <div className="whitespace-pre-line text-[#5b5b57]">{inv.seller.address}</div>}
          {inv.seller.state && <div className="text-[#5b5b57]">State: {inv.seller.state}</div>}
          {inv.seller.gstin && <div>GSTIN: <b>{inv.seller.gstin}</b></div>}
          {inv.seller.pan && <div className="text-[#5b5b57]">PAN: {inv.seller.pan}</div>}
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-6">
        <div>
          <div className="text-[10.5px] tracking-[0.08em] text-[#898984] uppercase">Billed to</div>
          <div className="mt-1 text-[13px] font-semibold">{inv.buyer.name}</div>
          {inv.buyer.address && <div className="whitespace-pre-line text-[#5b5b57]">{inv.buyer.address}</div>}
          {inv.buyer.state && <div className="text-[#5b5b57]">State / place of supply: {inv.buyer.state}</div>}
          <div>GSTIN: {inv.buyer.gstin ? <b>{inv.buyer.gstin}</b> : <span className="text-[#5b5b57]">Unregistered</span>}</div>
        </div>
        <div className="text-right">
          <div><span className="text-[#5b5b57]">Invoice date: </span>{fmtDate(inv.issuedAt)}</div>
          <div><span className="text-[#5b5b57]">Financial year: </span>{inv.fy}</div>
          <div><span className="text-[#5b5b57]">Client code: </span>{inv.buyer.code}</div>
        </div>
      </div>
      <table className="mt-5 w-full">
        <thead><tr className="border-y border-[#0b0b0b] text-left text-[10.5px] tracking-[0.06em] uppercase"><th className="py-2">Description</th><th className="py-2">SAC</th><th className="py-2 text-right">Qty</th><th className="py-2 text-right">Rate</th><th className="py-2 text-right">Amount</th></tr></thead>
        <tbody>
          {inv.lines.map((l, i) => (
            <tr key={i} className="border-b border-[#e8e8e4]"><td className="py-2 pr-3">{l.description}</td><td className="py-2">{l.sac}</td><td className="tnum py-2 text-right">{l.qty}</td><td className="tnum py-2 text-right">{money(l.unitCents, inv.currency)}</td><td className="tnum py-2 text-right">{money(l.amountCents, inv.currency)}</td></tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3 ml-auto w-72">
        <div className="flex justify-between"><span className="text-[#5b5b57]">Taxable value</span><span className="tnum">{money(Math.round(inv.taxable * 100), inv.currency)}</span></div>
        {inv.cgst > 0 && <div className="flex justify-between"><span className="text-[#5b5b57]">CGST @ {rate / 2}%</span><span className="tnum">{money(Math.round(inv.cgst * 100), inv.currency)}</span></div>}
        {inv.sgst > 0 && <div className="flex justify-between"><span className="text-[#5b5b57]">SGST @ {rate / 2}%</span><span className="tnum">{money(Math.round(inv.sgst * 100), inv.currency)}</span></div>}
        {inv.igst > 0 && <div className="flex justify-between"><span className="text-[#5b5b57]">IGST @ {rate}%</span><span className="tnum">{money(Math.round(inv.igst * 100), inv.currency)}</span></div>}
        <div className="mt-1 flex justify-between border-t border-[#0b0b0b] pt-1.5 text-[14px] font-semibold"><span>Total</span><span className="tnum">{money(Math.round(inv.total * 100), inv.currency)}</span></div>
      </div>
      {inv.currency === 'INR' && <div className="mt-3 text-[11.5px]"><span className="text-[#5b5b57]">Amount in words: </span>Rupees {words(rupees)}{paise ? ` and ${words(paise)} Paise` : ''} only</div>}
      <div className="mt-5 border-t border-[#e8e8e4] pt-3 text-[11px] text-[#5b5b57]">This is a computer-generated invoice and does not require a signature.{inv.seller.email ? ` Questions: ${inv.seller.email}` : ''}</div>
    </div>
  );
}

export function TaxInvoiceDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { data } = useApiQuery<TaxInvoice>(`/api/v1/finance/invoices/${id}`);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} size="xl" title={data ? `Invoice ${data.number}` : 'Invoice'} footer={<><Button variant="ghost" onClick={onClose}>Close</Button><Button variant="primary" disabled={!data} onClick={() => window.print()}><Printer /> Print / save PDF</Button></>}>
      {data ? <TaxInvoiceView inv={data} /> : <div className="h-64 animate-pulse rounded-lg bg-surface-2" />}
    </Dialog>
  );
}
