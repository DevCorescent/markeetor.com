'use client';
import { ArrowLeft, Save } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ErrorState, Skeleton } from '@/components/ui/states';
import { api, errorMessage } from '@/lib/api-client';
import { PRESETS } from '@/lib/email/presets';
import type { EmailDesign } from '@/lib/email/types';
import { useApiQuery } from '@/lib/hooks';
import { EmailEditor, type EmailDoc, type Sender } from './editor';

export function TemplatePage({ base, id }: { base: string; id: string }) {
  const router = useRouter();
  const sp = useSearchParams();
  const isNew = id === 'new';
  const existing = useApiQuery<{ id: string; name: string; category: string | null; subject: string; preheader: string | null; design: EmailDesign }>(isNew ? null : `/api/v1/email/templates/${id}`);
  const senders = useApiQuery<{ accounts: Sender[] }>('/api/v1/email/smtp');
  const [name, setName] = useState('');
  const [doc, setDoc] = useState<EmailDoc | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (isNew && !doc) {
      const p = PRESETS.find((x) => x.key === sp.get('preset')) ?? PRESETS[0];
      setDoc({ subject: p.subject, preheader: p.preheader, design: p.design() });
      setName(p.key === 'blank' ? 'Untitled template' : p.name);
    } else if (existing.data && !doc) {
      setDoc({ subject: existing.data.subject, preheader: existing.data.preheader ?? '', design: existing.data.design });
      setName(existing.data.name);
    }
  }, [isNew, existing.data, doc, sp]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirty) e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  if (existing.error) return <ErrorState description={errorMessage(existing.error)} />;
  if (!doc) return <Skeleton className="h-[720px]" />;

  const save = async () => {
    setSaving(true);
    try {
      const body = { name, subject: doc.subject, preheader: doc.preheader || null, design: doc.design };
      const res = await api<{ id: string }>(isNew ? '/api/v1/email/templates' : `/api/v1/email/templates/${id}`, { method: isNew ? 'POST' : 'PUT', body });
      toast.success('Template saved');
      setDirty(false);
      if (isNew) router.replace(`${base}/email/templates/${res.id}`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => router.push(`${base}/email?tab=templates`)}><ArrowLeft /> Templates</Button>
        <Input value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} className="h-9 max-w-sm text-[15px] font-medium" aria-label="Template name" />
        {dirty && <span className="text-[11px] text-subtle">Unsaved changes</span>}
        <div className="ml-auto flex gap-2">
          {!isNew && <Button onClick={() => router.push(`${base}/leads?emailTemplate=${id}`)}>Use in campaign</Button>}
          <Button variant="primary" loading={saving} disabled={name.trim().length < 2} onClick={save}><Save /> Save template</Button>
        </div>
      </div>
      <EmailEditor value={doc} onChange={(d) => { setDoc(d); setDirty(true); }} senders={senders.data?.accounts ?? []} />
    </div>
  );
}
