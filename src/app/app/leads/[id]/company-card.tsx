'use client';
import { ResearchScore } from '@/components/company/research-score';
import { ExternalLink, Search } from 'lucide-react';
import { useState } from 'react';
import { CompanyLinks, RegistrationBlock, type Registration } from '@/components/company/registry-view';
import { Badge } from '@/components/ui/badge';
import type { CompanyLink } from '@/lib/company-registry';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, DefinitionList } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/states';
import { api, errorMessage } from '@/lib/api-client';
import { fmtAgo } from '@/lib/format';
import { useApiQuery } from '@/lib/hooks';

type Profile = {
  status: string; researchedAt: string | null; confidence: number; name: string | null; industry: string | null; specialty: string | null; description: string | null;
  size: string | null; founded: number | null; headquarters: string | null; keywords: string[]; sellsTo: string | null; website: string | null; linkedin: string | null;
  sources: { url: string; title: string | null }[];
  registration: Registration | null; links: CompanyLink[];
};
type Quota = { enabled: boolean; used: number; limit: number };

const link = (u: string) => <a href={u} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 break-all hover:underline">{u.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}<ExternalLink className="size-3 shrink-0" /></a>;

/** Company research for a lead in the workspace: shared platform-wide, so it is only ever done once. */
export function CompanyCard({ leadId, onUpdated }: { leadId: string; onUpdated?: () => void }) {
  const { data, refetch } = useApiQuery<{ profile: Profile | null; links: CompanyLink[]; quota: Quota }>(`/api/v1/crm/leads/${leadId}/research`);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (!data) return <Skeleton className="h-40" />;
  const p = data.profile;
  const run = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ status: string }>(`/api/v1/crm/leads/${leadId}/research`, { method: 'POST' });
      if (r.status !== 'DONE') setMsg('No public website was found for this company, so only basic details are available.');
      await refetch();
      onUpdated?.();
    } catch (e) {
      setMsg(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const researched = p?.status === 'DONE' || (p?.status === 'PARTIAL' && Boolean(p.name || p.industry || p.registration));
  return (
    <Card>
      <CardHeader title="Company" description={researched && p?.researchedAt ? `AI research · ${fmtAgo(p.researchedAt)}` : 'Public information about this lead’s company'}
        actions={p && (p.status === 'DONE' || p.status === 'PARTIAL') ? <ResearchScore size="lg" r={{ score: p.confidence, status: p.status, researchedAt: p.researchedAt }} /> : null} />
      <CardBody className="flex flex-col gap-3">
        {researched && p ? (
          <>
            {p.status === 'PARTIAL' && <p className="rounded-md bg-surface-2 px-3 py-2 text-[12px] text-muted">No public website was found for this company — showing what could be confirmed. The directory links below help verify its registration.</p>}
            {p.name && <div className="text-[14px] font-medium">{p.name}</div>}
            {p.description && <p className="text-[12.5px] leading-relaxed text-fg-2">{p.description}</p>}
            <DefinitionList items={[
              ['Industry', [p.industry, p.specialty].filter(Boolean).join(' · ') || '—'],
              ['Employees', p.size ? p.size.replace('-', '–') : '—'],
              ['Founded', p.founded ?? '—'],
              ['Headquarters', p.headquarters ?? '—'],
              ['Sells to', p.sellsTo ?? '—'],
              ['Website', p.website ? link(p.website) : '—'],
              ['LinkedIn', p.linkedin ? link(p.linkedin) : '—'],
            ]} />
            {p.keywords.length > 0 && <div className="flex flex-wrap gap-1">{p.keywords.map((k) => <Badge key={k} tone="outline">{k}</Badge>)}</div>}
            {p.registration && <RegistrationBlock reg={p.registration} />}
          </>
        ) : (
          <div className="flex flex-col gap-2.5">
            <p className="text-[12.5px] leading-relaxed text-muted">{p?.status === 'PARTIAL' ? 'We couldn’t find this company’s website last time. You can try again — research is saved for everyone, so it never has to be repeated.' : 'Not researched yet. Research reads the company’s public website and saves a profile — what it does, size, history and markets.'}</p>
            {msg && <p className="text-[12px] text-warn">{msg}</p>}
            {data.quota.enabled ? (
              <div className="flex items-center gap-3">
                <Button size="sm" variant="primary" loading={busy} onClick={run}>{busy ? 'Researching…' : <><Search /> Research this company</>}</Button>
                <span className="text-[11.5px] text-subtle">{busy ? 'Up to 30 seconds' : `${Math.max(0, data.quota.limit - data.quota.used)} of ${data.quota.limit} credits left today`}</span>
              </div>
            ) : <p className="text-[11.5px] text-subtle">Company research is turned off by the platform.</p>}
          </div>
        )}
        <CompanyLinks links={data.links} />
      </CardBody>
    </Card>
  );
}
