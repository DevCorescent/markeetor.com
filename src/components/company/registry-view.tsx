'use client';
import { ExternalLink, Landmark } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/cn';
import type { CompanyLink } from '@/lib/company-registry';

export type Registration = {
  source: 'falconebiz' | 'opencorporates' | 'website-cin' | 'web' | 'manual' | null; regId: string | null; legalName: string | null; status: string | null;
  incorporated: string | null; yearIncorporated: number | null; type: string | null; category: string | null; listed: boolean | null;
  roc: string | null; registeredIn: string | null; activity: string | null; paidUpCapital: number | null; authorisedCapital: number | null; url: string | null;
};

const SOURCE: Record<string, string> = { falconebiz: 'MCA records via Falcon eBiz', opencorporates: 'OpenCorporates registry data', 'website-cin': 'CIN printed on the company website', web: 'Found by AI web research', manual: 'Added by the platform team' };
const inr = (n: number) => `₹${n.toLocaleString('en-IN')}`;
const age = (y: number | null) => (y ? `${new Date().getFullYear() - y} yrs` : null);

/** Official registration facts — no directors, addresses or contact details. */
export function RegistrationBlock({ reg, className }: { reg: Registration; className?: string }) {
  const rows: [string, React.ReactNode][] = [
    ['Legal name', reg.legalName],
    [reg.regId?.length === 21 ? 'CIN' : /^[A-Z]{3}-\d{4}$/.test(reg.regId ?? '') ? 'LLPIN' : 'Registration no.', reg.regId ? <span className="font-mono text-[11.5px]">{reg.regId}</span> : null],
    ['Status', reg.status ? <Badge tone={/active|live/i.test(reg.status) ? 'ok' : 'warn'}>{reg.status}</Badge> : null],
    ['Incorporated', reg.incorporated ? `${reg.incorporated}${reg.yearIncorporated ? ` · ${age(reg.yearIncorporated)}` : ''}` : reg.yearIncorporated ? `${reg.yearIncorporated} · ${age(reg.yearIncorporated)}` : null],
    ['Company type', [reg.type, reg.listed == null ? null : reg.listed ? 'Listed' : 'Unlisted'].filter(Boolean).join(' · ') || null],
    ['Registered in', [reg.registeredIn, reg.roc].filter(Boolean).join(' · ') || null],
    ['Activity', reg.activity],
    ['Paid-up capital', reg.paidUpCapital ? `${inr(reg.paidUpCapital)}${reg.authorisedCapital ? ` of ${inr(reg.authorisedCapital)} authorised` : ''}` : null],
  ].filter(([, v]) => v != null && v !== '') as [string, React.ReactNode][];
  if (!rows.length) return null;
  return (
    <div className={cn('rounded-lg border border-border bg-surface', className)}>
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-[12.5px] font-medium"><Landmark className="size-3.5 text-muted" />Official registration<span className="ml-auto text-[10.5px] font-normal text-subtle">{SOURCE[reg.source ?? ''] ?? 'Registry'}</span></div>
      <dl className="grid grid-cols-[minmax(100px,36%)_1fr] gap-x-3 gap-y-2 px-4 py-3 text-[12.5px]">
        {rows.map(([k, v]) => <div key={k} className="contents"><dt className="text-subtle">{k}</dt><dd className="min-w-0 break-words text-fg-2">{v}</dd></div>)}
      </dl>
    </div>
  );
}

/** One-click checks on company directories (open in a new tab). */
export function CompanyLinks({ links, title = 'Check this company on' }: { links: CompanyLink[]; title?: string }) {
  if (!links.length) return null;
  const direct = links.some((l) => l.direct);
  const india = links.some((l) => l.key === 'zaubacorp');
  return (
    <div>
      <div className="eyebrow mb-2">{title}</div>
      <div className="flex flex-wrap gap-1.5">
        {links.map((l) => (
          <a key={l.key} href={l.url} target="_blank" rel="noreferrer noopener" title={l.hint}
            className={cn('inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[12px] transition-colors hover:border-fg/40 hover:bg-surface-3 hover:text-fg', l.direct ? 'border-fg/30 bg-surface-2 font-medium text-fg' : 'border-border-strong bg-surface text-fg-2')}>
            {l.label}{l.direct && <span className="rounded bg-fg px-1 text-[9.5px] font-semibold tracking-wide text-inverse uppercase">Page</span>}<ExternalLink className="size-3 opacity-60" />
          </a>
        ))}
      </div>
      {india && !direct && <p className="mt-2 text-[11px] text-subtle">ZaubaCorp lists each matching company with its CIN/LLPIN. Once the CIN is known, direct pages on Falcon eBiz, Tofler and The Company Check appear here.</p>}
    </div>
  );
}

/** Platform team: attach a CIN/LLPIN (e.g. copied from ZaubaCorp) to unlock registry data and direct pages. */
export function CinInput({ onSave, current }: { onSave: (cin: string) => Promise<void>; current?: string | null }) {
  return (
    <form className="flex items-center gap-2" onSubmit={async (e) => {
      e.preventDefault();
      const input = (e.currentTarget.elements.namedItem('cin') as HTMLInputElement);
      await onSave(input.value);
      input.value = '';
    }}>
      <input name="cin" placeholder={current ? `Replace ${current}` : 'Paste CIN or LLPIN (from ZaubaCorp/MCA)'} maxLength={30} className="h-8 min-w-0 flex-1 rounded-md border border-border-strong bg-surface-2 px-2.5 font-mono text-[12px] uppercase outline-none placeholder:font-sans placeholder:normal-case focus:border-fg/40" />
      <button type="submit" className="h-8 shrink-0 rounded-md bg-fg px-3 text-[12px] font-medium text-inverse hover:bg-fg-2">Save</button>
    </form>
  );
}
