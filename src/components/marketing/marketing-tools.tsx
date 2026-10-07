'use client';
import { useQueryClient } from '@tanstack/react-query';
import { Bot, Copy, ExternalLink, FileInput, Link2, Plus, QrCode, Sparkles, Trash2, X } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Dialog, Switch } from '@/components/ui/overlay';
import { InlineNotice, Skeleton } from '@/components/ui/states';
import { api, errorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { fmtAgo, fmtDateTime, fmtInt } from '@/lib/format';
import { useApiQuery } from '@/lib/hooks';
import { DEFAULT_FORM, FORM_FIELD_TYPES, type FormConfig } from '@/lib/marketing';
import { CaptureFormView } from './capture-form';

const invalidate = (qc: ReturnType<typeof useQueryClient>) => qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0] ?? '').startsWith('/api/v1/marketing') });
const copy = async (text: string, what = 'Copied') => { try { await navigator.clipboard.writeText(text); toast.success(what); } catch { toast.error('Could not copy'); } };
/** APP_URL may be unset in development — fall back to the browser origin after mount. */
const noop = () => () => {};
function useOrigin(base: string | undefined) {
  const origin = useSyncExternalStore(noop, () => window.location.origin, () => '');
  return base || origin;
}

// ── Forms ──────────────────────────────────────────────────────────

type Form = { id: string; slug: string; name: string; config: FormConfig; status: string; sequenceId: string | null; submissions: number; views: number; reviewNote: string | null; createdAt: string };
type FormDraft = { id: string | null; name: string; config: FormConfig; sequenceId: string | null; status: 'ACTIVE' | 'PAUSED' };
const MAP_TO = [['fullName', 'Name'], ['email', 'Email'], ['phone', 'Phone'], ['company', 'Company'], ['jobTitle', 'Job title'], ['city', 'City'], ['note', 'Note'], ['custom', 'Other']] as const;

export function FormsTab() {
  const qc = useQueryClient();
  const { data } = useApiQuery<{ rows: Form[]; base: string }>('/api/v1/marketing/forms');
  const seqs = useApiQuery<{ rows: { id: string; name: string; status: string }[] }>('/api/v1/marketing/sequences');
  const origin = useOrigin(data?.base);
  const [edit, setEdit] = useState<FormDraft | null>(null);
  const [subs, setSubs] = useState<Form | null>(null);
  const [embed, setEmbed] = useState<Form | null>(null);
  const save = async () => {
    if (!edit) return;
    try {
      const r = await api<Form>(edit.id ? `/api/v1/marketing/forms/${edit.id}` : '/api/v1/marketing/forms', { method: edit.id ? 'PUT' : 'POST', body: { name: edit.name, config: edit.config, sequenceId: edit.sequenceId, status: edit.status } });
      toast.success(r.status === 'PENDING_REVIEW' ? 'Saved — it goes live after a quick platform review' : 'Form saved');
      setEdit(null); await invalidate(qc);
    } catch (e) { toast.error(errorMessage(e)); }
  };
  const c = edit?.config;
  const setField = (i: number, p: Partial<FormConfig['fields'][number]>) => edit && c && setEdit({ ...edit, config: { ...c, fields: c.fields.map((f, j) => (j === i ? { ...f, ...p } : f)) } });
  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end"><Button variant="primary" onClick={() => setEdit({ id: null, name: '', config: DEFAULT_FORM, sequenceId: null, status: 'ACTIVE' })}><Plus /> New form</Button></div>
      {!data ? <Skeleton className="h-40" /> : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {data.rows.map((f) => (
            <Card key={f.id} className="flex flex-col gap-3 p-4">
              <div className="flex items-center gap-2"><span className="grid size-8 place-items-center rounded-lg text-white" style={{ background: f.config.accent }}><FileInput className="size-4" /></span><span className="min-w-0 flex-1 truncate font-medium">{f.name}</span><StatusBadge status={f.status} /></div>
              {f.reviewNote && <div className="text-[11.5px] text-warn">{f.reviewNote}</div>}
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-md bg-surface-2 py-1.5"><div className="tnum font-semibold">{fmtInt(f.views)}</div><div className="text-[10.5px] text-subtle">views</div></div>
                <div className="rounded-md bg-ok-dim py-1.5 text-ok"><div className="tnum font-semibold">{fmtInt(f.submissions)}</div><div className="text-[10.5px]">leads</div></div>
                <div className="rounded-md bg-surface-2 py-1.5"><div className="tnum font-semibold">{f.views ? `${Math.round((f.submissions / f.views) * 100)}%` : '—'}</div><div className="text-[10.5px] text-subtle">conversion</div></div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Button size="xs" onClick={() => copy(`${origin}/f/${f.slug}`, 'Form link copied')}><Copy /> Link</Button>
                <Button size="xs" onClick={() => setEmbed(f)}>Embed</Button>
                <Button size="xs" variant="ghost" onClick={() => setSubs(f)}>Submissions</Button>
                <Button size="xs" variant="ghost" onClick={() => setEdit({ id: f.id, name: f.name, config: f.config, sequenceId: f.sequenceId, status: f.status === 'PAUSED' ? 'PAUSED' : 'ACTIVE' })}>Edit</Button>
                <a href={`/f/${f.slug}`} target="_blank" rel="noreferrer" className="inline-flex h-6 items-center px-1.5 text-muted hover:text-fg" aria-label="Open form"><ExternalLink className="size-3.5" /></a>
                <Button size="xs" variant="ghost" className="ml-auto" aria-label="Delete" onClick={async () => { try { await api(`/api/v1/marketing/forms/${f.id}`, { method: 'DELETE' }); await invalidate(qc); } catch (e) { toast.error(errorMessage(e)); } }}><Trash2 /></Button>
              </div>
            </Card>
          ))}
          {!data.rows.length && <Card className="py-12 text-center text-[12.5px] text-subtle md:col-span-3">Create a lead form, share its link or embed it on your website — every submission lands in your leads, deduplicated, with consent recorded.</Card>}
        </div>
      )}
      {edit && c && (
        <Dialog open onOpenChange={(o) => !o && setEdit(null)} title={edit.id ? 'Edit form' : 'New lead form'} size="xl" footer={<><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" disabled={edit.name.trim().length < 2 || c.title.trim().length < 2} onClick={save}>Save form</Button></>}>
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_340px]">
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Internal name"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="e.g. Website enquiry" autoFocus /></Field>
                <Field label="Heading"><Input value={c.title} onChange={(e) => setEdit({ ...edit, config: { ...c, title: e.target.value } })} /></Field>
              </div>
              <Field label="Intro text"><Textarea rows={2} value={c.description} onChange={(e) => setEdit({ ...edit, config: { ...c, description: e.target.value } })} /></Field>
              <div className="flex flex-col gap-2">
                <div className="text-[12px] font-medium">Fields</div>
                {c.fields.map((f, i) => (
                  <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-center gap-1.5 max-sm:rounded-lg max-sm:border max-sm:border-border max-sm:p-2 sm:grid-cols-[1fr_110px_110px_auto_auto]">
                    <Input className="h-8 max-sm:col-span-2" value={f.label} onChange={(e) => setField(i, { label: e.target.value })} aria-label="Label" />
                    <Select className="h-8" value={f.type} onChange={(e) => setField(i, { type: e.target.value as (typeof FORM_FIELD_TYPES)[number] })} aria-label="Type">{FORM_FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</Select>
                    <Select className="h-8" value={f.mapTo} onChange={(e) => setField(i, { mapTo: e.target.value as FormConfig['fields'][number]['mapTo'] })} aria-label="Saves to">{MAP_TO.map(([v, l]) => <option key={v} value={v}>→ {l}</option>)}</Select>
                    <label className="flex items-center gap-1 text-[11px] text-muted"><input type="checkbox" checked={f.required} onChange={(e) => setField(i, { required: e.target.checked })} />req.</label>
                    <Button size="xs" variant="ghost" className="max-sm:col-start-3 max-sm:row-start-1" disabled={c.fields.length < 2} onClick={() => setEdit({ ...edit, config: { ...c, fields: c.fields.filter((_, j) => j !== i) } })} aria-label="Remove"><X /></Button>
                    {f.type === 'select' && <Input className="col-span-3 h-8 sm:col-span-5" placeholder="Options, comma separated" value={f.options.join(', ')} onChange={(e) => setField(i, { options: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />}
                  </div>
                ))}
                <Button size="sm" variant="outline" className="self-start" disabled={c.fields.length >= 20} onClick={() => setEdit({ ...edit, config: { ...c, fields: [...c.fields, { key: `field_${c.fields.length + 1}`, label: 'New question', type: 'text', required: false, options: [], mapTo: 'custom' }] } })}><Plus /> Add field</Button>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Field label="Button text"><Input value={c.button} onChange={(e) => setEdit({ ...edit, config: { ...c, button: e.target.value } })} /></Field>
                <Field label="Colour"><Input type="color" className="h-8 p-1" value={c.accent} onChange={(e) => setEdit({ ...edit, config: { ...c, accent: e.target.value } })} /></Field>
                <Field label="Status"><Select value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value as 'ACTIVE' | 'PAUSED' })}><option value="ACTIVE">Active</option><option value="PAUSED">Paused</option></Select></Field>
              </div>
              <Field label="Thank-you message"><Input value={c.thankYou} onChange={(e) => setEdit({ ...edit, config: { ...c, thankYou: e.target.value } })} /></Field>
              <Field label="Redirect after submit (optional)"><Input value={c.redirectUrl ?? ''} placeholder="https://…" onChange={(e) => setEdit({ ...edit, config: { ...c, redirectUrl: e.target.value.trim() || null } })} /></Field>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Then start sequence"><Select value={edit.sequenceId ?? ''} onChange={(e) => setEdit({ ...edit, sequenceId: e.target.value || null })}><option value="">None</option>{(seqs.data?.rows ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}{s.status !== 'ACTIVE' ? ` (${s.status.toLowerCase()})` : ''}</option>)}</Select></Field>
                <label className="flex items-center justify-between gap-2 self-end pb-1.5 text-[12.5px]">Ask for messaging consent<Switch checked={c.consent} onCheckedChange={(v) => setEdit({ ...edit, config: { ...c, consent: v } })} aria-label="Consent" /></label>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <div className="eyebrow">Live preview</div>
              <div className="rounded-xl border border-border bg-[#f4f4f5] p-3"><CaptureFormView form={{ slug: 'preview', name: edit.name, organization: '', config: c }} embed preview /></div>
            </div>
          </div>
        </Dialog>
      )}
      {embed && (
        <Dialog open onOpenChange={(o) => !o && setEmbed(null)} title={`Share “${embed.name}”`}>
          <div className="flex flex-col gap-3 text-[12.5px]">
            {[['Hosted page', `${origin}/f/${embed.slug}`], ['Embed on your website', `<iframe src="${origin}/f/${embed.slug}?embed=1" style="width:100%;max-width:520px;height:640px;border:0" loading="lazy" title="${embed.name.replace(/"/g, '')}"></iframe>`]].map(([k, v]) => (
              <div key={k}><div className="mb-1 font-medium">{k}</div><div className="flex gap-1.5"><code className="min-w-0 flex-1 rounded-md bg-surface-2 px-2 py-1.5 font-mono text-[11px] break-all">{v}</code><Button size="sm" onClick={() => copy(v)} aria-label="Copy"><Copy /></Button></div></div>
            ))}
            <p className="text-subtle">UTM tags on the page address (utm_source, utm_campaign…) are saved with each lead.</p>
          </div>
        </Dialog>
      )}
      {subs && <SubmissionsDialog form={subs} onClose={() => setSubs(null)} />}
    </div>
  );
}

function SubmissionsDialog({ form, onClose }: { form: Form; onClose: () => void }) {
  const { data } = useApiQuery<{ rows: { id: string; data: Record<string, string>; utm: Record<string, string> | null; clientLeadId: string | null; createdAt: string }[] }>(`/api/v1/marketing/forms/${form.id}/submissions`);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Submissions — ${form.name}`} size="xl">
      {!data ? <Skeleton className="h-40" /> : !data.rows.length ? <p className="py-8 text-center text-[12.5px] text-subtle">No submissions yet.</p> : (
        <div className="max-h-[60vh] overflow-auto"><table className="w-full text-[12px]">
          <thead><tr className="border-b border-border text-left text-[10.5px] tracking-[0.08em] text-subtle uppercase"><th className="h-8 pr-3 font-medium">When</th>{form.config.fields.map((f) => <th key={f.key} className="pr-3 font-medium">{f.label}</th>)}<th className="font-medium">Source</th><th /></tr></thead>
          <tbody>{data.rows.map((r) => <tr key={r.id} className="border-b border-border/60 align-top"><td className="py-1.5 pr-3 whitespace-nowrap text-subtle" title={fmtDateTime(r.createdAt)}>{fmtAgo(r.createdAt)}</td>{form.config.fields.map((f) => <td key={f.key} className="max-w-[220px] truncate pr-3">{r.data[f.key] ?? ''}</td>)}<td className="pr-3 text-subtle">{r.utm?.utm_source ?? '—'}</td><td>{r.clientLeadId && <a className="text-info hover:underline" href={`/app/leads/${r.clientLeadId}`}>Lead</a>}</td></tr>)}</tbody>
        </table></div>
      )}
    </Dialog>
  );
}

// ── Links & QR ─────────────────────────────────────────────────────

type TLink = { id: string; code: string; name: string; url: string; utmSource: string | null; utmMedium: string | null; utmCampaign: string | null; clicks: number; uniqueLeads: number; lastClickAt: string | null; createdAt: string };

export function LinksTab() {
  const qc = useQueryClient();
  const { data } = useApiQuery<{ rows: TLink[]; base: string }>('/api/v1/marketing/links');
  const origin = useOrigin(data?.base ? data.base.replace(/\/l\/$/, '') : undefined);
  const [d, setD] = useState<{ name: string; url: string; utmSource: string; utmMedium: string; utmCampaign: string } | null>(null);
  const [qr, setQr] = useState<{ name: string; url: string; svg: string } | null>(null);
  const create = async () => {
    if (!d) return;
    try { await api('/api/v1/marketing/links', { body: d }); toast.success('Tracked link created'); setD(null); await invalidate(qc); } catch (e) { toast.error(errorMessage(e)); }
  };
  const short = (l: TLink) => `${origin}/l/${l.code}`;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2"><p className="text-[12px] text-subtle">Use <code className="rounded bg-surface-2 px-1">{'{link:CODE}'}</code> in a WhatsApp/SMS message to see which lead clicked.</p><Button variant="primary" onClick={() => setD({ name: '', url: '', utmSource: '', utmMedium: '', utmCampaign: '' })}><Plus /> New link</Button></div>
      <Card>
        {!data ? <Skeleton className="m-4 h-32" /> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-[12.5px]">
            <thead><tr className="border-b border-border text-left text-[10.5px] tracking-[0.08em] text-subtle uppercase">{['Link', 'Short link', 'Clicks', 'Leads', 'Last click', ''].map((h) => <th key={h} className="h-9 px-4 font-medium">{h}</th>)}</tr></thead>
            <tbody>
              {data.rows.map((l) => (
                <tr key={l.id} className="border-b border-border/60 last:border-0">
                  <td className="px-4 py-2"><div className="font-medium">{l.name}</div><div className="max-w-[260px] truncate text-[11px] text-subtle">{l.url}</div></td>
                  <td className="px-4"><button type="button" onClick={() => copy(short(l), 'Link copied')} className="inline-flex items-center gap-1 font-mono text-[11.5px] text-info hover:underline"><Link2 className="size-3" />/l/{l.code}</button></td>
                  <td className="tnum px-4 font-semibold">{fmtInt(l.clicks)}</td>
                  <td className="tnum px-4">{fmtInt(l.uniqueLeads)}</td>
                  <td className="px-4 text-subtle">{l.lastClickAt ? fmtAgo(l.lastClickAt) : '—'}</td>
                  <td className="px-4 text-right whitespace-nowrap">
                    <Button size="xs" variant="ghost" onClick={async () => { try { const r = await api<{ url: string; svg: string }>(`/api/v1/marketing/links/${l.id}/qr`); setQr({ name: l.name, ...r }); } catch (e) { toast.error(errorMessage(e)); } }}><QrCode /> QR</Button>
                    <Button size="xs" variant="ghost" aria-label="Delete" onClick={async () => { await api(`/api/v1/marketing/links/${l.id}`, { method: 'DELETE' }); await invalidate(qc); }}><Trash2 /></Button>
                  </td>
                </tr>
              ))}
              {!data.rows.length && <tr><td colSpan={6} className="py-10 text-center text-subtle">Short, trackable links and QR codes for posters, visiting cards, ads and messages.</td></tr>}
            </tbody>
          </table></div>
        )}
      </Card>
      {d && (
        <Dialog open onOpenChange={(o) => !o && setD(null)} title="New tracked link" footer={<><Button variant="ghost" onClick={() => setD(null)}>Cancel</Button><Button variant="primary" disabled={d.name.trim().length < 2 || !/^https?:\/\//.test(d.url)} onClick={create}>Create</Button></>}>
          <div className="flex flex-col gap-3">
            <Field label="Name"><Input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="e.g. Brochure PDF" autoFocus /></Field>
            <Field label="Destination"><Input value={d.url} onChange={(e) => setD({ ...d, url: e.target.value })} placeholder="https://yourwebsite.com/offer" /></Field>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <Field label="utm_source"><Input value={d.utmSource} onChange={(e) => setD({ ...d, utmSource: e.target.value })} placeholder="whatsapp" /></Field>
              <Field label="utm_medium"><Input value={d.utmMedium} onChange={(e) => setD({ ...d, utmMedium: e.target.value })} placeholder="message" /></Field>
              <Field label="utm_campaign"><Input value={d.utmCampaign} onChange={(e) => setD({ ...d, utmCampaign: e.target.value })} placeholder="diwali" /></Field>
            </div>
          </div>
        </Dialog>
      )}
      {qr && (
        <Dialog open onOpenChange={(o) => !o && setQr(null)} title={`QR code — ${qr.name}`} size="sm" footer={<Button variant="primary" onClick={() => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([qr.svg], { type: 'image/svg+xml' })); a.download = `${qr.name.replace(/\W+/g, '-').toLowerCase()}-qr.svg`; a.click(); URL.revokeObjectURL(a.href); }}>Download SVG</Button>}>
          <div className="mx-auto w-56 rounded-lg bg-white p-3 [&_svg]:h-auto [&_svg]:w-full" dangerouslySetInnerHTML={{ __html: qr.svg }} />
          <p className="mt-2 text-center font-mono text-[11px] text-subtle">{qr.url}</p>
        </Dialog>
      )}
    </div>
  );
}

// ── AI writer ──────────────────────────────────────────────────────

const KINDS = [['whatsapp', 'WhatsApp message'], ['sms', 'SMS'], ['email', 'Sales email'], ['linkedin', 'LinkedIn post'], ['instagram', 'Instagram caption'], ['facebook_ad', 'Facebook ad'], ['google_ad', 'Google search ad']] as const;
const LANGS = ['English', 'Hindi', 'Hinglish', 'Marathi', 'Tamil', 'Telugu', 'Gujarati', 'Bengali', 'Kannada'] as const;
const TONES = ['professional', 'friendly', 'persuasive', 'casual', 'urgent'] as const;

export function WriterTab({ pricing }: { pricing: number }) {
  const [f, setF] = useState({ kind: 'whatsapp' as string, topic: '', tone: 'friendly' as string, language: 'English' as string, audience: '' });
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{ text: string; engine: string; credits: number; flagged: string | null }[]>([]);
  const run = async () => {
    setBusy(true);
    try { const r = await api<{ text: string; engine: string; credits: number; flagged: string | null }>('/api/v1/marketing/ai-write', { body: { ...f, audience: f.audience || undefined } }); setOut((o) => [r, ...o].slice(0, 6)); } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[380px_1fr]">
      <Card className="self-start">
        <CardHeader title="What should I write?" description={`AI drafts cost ${pricing} credit${pricing === 1 ? '' : 's'}; template drafts are free`} />
        <CardBody className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-1.5">{KINDS.map(([k, l]) => <button key={k} type="button" onClick={() => setF({ ...f, kind: k })} className={cn('rounded-full border px-2.5 py-1 text-[11.5px]', f.kind === k ? 'border-fg bg-fg text-inverse' : 'border-border text-muted hover:text-fg')}>{l}</button>)}</div>
          <Field label="About"><Textarea rows={4} value={f.topic} maxLength={600} onChange={(e) => setF({ ...f, topic: e.target.value })} placeholder="e.g. 20% off rooftop solar installation for factories this Diwali, free site survey" /></Field>
          <Field label="Audience (optional)"><Input value={f.audience} onChange={(e) => setF({ ...f, audience: e.target.value })} placeholder="e.g. factory owners in Pune" /></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Tone"><Select value={f.tone} onChange={(e) => setF({ ...f, tone: e.target.value })}>{TONES.map((t) => <option key={t} value={t}>{t}</option>)}</Select></Field>
            <Field label="Language"><Select value={f.language} onChange={(e) => setF({ ...f, language: e.target.value })}>{LANGS.map((t) => <option key={t}>{t}</option>)}</Select></Field>
          </div>
          <Button variant="primary" loading={busy} disabled={f.topic.trim().length < 3} onClick={run}><Sparkles /> Write it</Button>
        </CardBody>
      </Card>
      <div className="flex flex-col gap-3">
        {!out.length && <Card className="grid place-items-center gap-2 py-16 text-center text-[12.5px] text-subtle"><Bot className="size-6" />Drafts appear here. Merge tags like {'{first_name}'} are filled in per lead when you send.</Card>}
        {out.map((o, i) => (
          <Card key={i} className="p-4">
            <div className="mb-2 flex items-center gap-2 text-[11px]"><span className={cn('rounded-full px-2 py-0.5', o.engine === 'claude' ? 'bg-accent-dim text-accent' : 'bg-surface-3 text-muted')}>{o.engine === 'claude' ? 'AI' : 'Template'}</span>{o.credits > 0 && <span className="text-subtle">{o.credits} credits</span>}<Button size="xs" className="ml-auto" onClick={() => copy(o.text)}><Copy /> Copy</Button></div>
            {o.flagged && <InlineNotice tone="warn" className="mb-2">Contains a blocked word (“{o.flagged}”) — edit before sending.</InlineNotice>}
            <pre className="font-sans text-[13px] leading-relaxed whitespace-pre-wrap">{o.text}</pre>
          </Card>
        ))}
      </div>
    </div>
  );
}
