'use client';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { FormConfig } from '@/lib/marketing';
import { cn } from '@/lib/cn';

type Form = { slug: string; name: string; organization: string; config: FormConfig };

/** Public lead-capture form (always light, works inside an iframe). */
export function CaptureFormView({ form, embed, preview = false }: { form: Form; embed?: boolean; preview?: boolean }) {
  const c = form.config;
  const [vals, setVals] = useState<Record<string, string>>({});
  const [consent, setConsent] = useState(false);
  const [hp, setHp] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const started = useRef(0);
  const utm = useRef<Record<string, string>>({});
  useEffect(() => {
    started.current = Date.now();
    try { const p = new URLSearchParams(window.location.search); utm.current = Object.fromEntries([...p.entries()].filter(([k]) => /^utm_/.test(k)).map(([k, v]) => [k.slice(0, 20), v.slice(0, 200)])); } catch { /* ignore */ }
  }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (preview) { setDone(c.thankYou); return; }
    setBusy(true); setErrors({});
    try {
      const res = await fetch(`/api/v1/public/capture/${form.slug}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answers: vals, consent, hp: hp || undefined, utm: utm.current, startedAt: started.current }) });
      const j = await res.json();
      if (!res.ok) { setErrors(j.error?.details?.fields ?? { _: j.error?.message ?? 'Something went wrong' }); return; }
      const d = j.data ?? j;
      if (d.redirectUrl) { (window.top ?? window).location.href = d.redirectUrl; return; }
      setDone(d.thankYou);
    } catch {
      setErrors({ _: 'Network error — please try again.' });
    } finally { setBusy(false); }
  };
  const card = (
    <div className={cn('w-full max-w-md rounded-2xl border border-[#e8e8e4] bg-white p-6 text-[#0b0b0b] shadow-sm', embed && 'max-w-none border-0 shadow-none')}>
      {done ? (
        <div className="flex flex-col items-center gap-3 py-8 text-center"><CheckCircle2 className="size-10" style={{ color: c.accent }} /><p className="text-[15px] font-medium">{done}</p></div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-3.5" noValidate>
          <div><h1 className="text-[20px] font-semibold tracking-[-0.02em]">{c.title}</h1>{c.description && <p className="mt-1 text-[13.5px] leading-relaxed text-[#5b5b57]">{c.description}</p>}</div>
          {c.fields.map((f) => (
            <label key={f.key} className="flex flex-col gap-1 text-[13px]">
              <span className="font-medium">{f.label}{f.required && <span className="text-[#cf3328]"> *</span>}</span>
              {f.type === 'textarea' ? <textarea rows={3} value={vals[f.key] ?? ''} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} className="rounded-lg border border-[#d9d9d4] px-3 py-2 outline-none focus:border-[#0b0b0b]" />
                : f.type === 'select' ? <select value={vals[f.key] ?? ''} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} className="h-10 rounded-lg border border-[#d9d9d4] bg-white px-3 outline-none focus:border-[#0b0b0b]"><option value="">Choose…</option>{f.options.map((o) => <option key={o}>{o}</option>)}</select>
                : <input type={f.type === 'email' ? 'email' : f.type === 'phone' ? 'tel' : f.type === 'number' ? 'number' : 'text'} value={vals[f.key] ?? ''} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} autoComplete={f.mapTo === 'fullName' ? 'name' : f.mapTo === 'email' ? 'email' : f.mapTo === 'phone' ? 'tel' : f.mapTo === 'company' ? 'organization' : 'off'} className="h-10 rounded-lg border border-[#d9d9d4] px-3 outline-none focus:border-[#0b0b0b]" />}
              {errors[f.key] && <span className="text-[12px] text-[#cf3328]">{errors[f.key]}</span>}
            </label>
          ))}
          <input tabIndex={-1} autoComplete="off" value={hp} onChange={(e) => setHp(e.target.value)} className="absolute -left-[9999px] h-0 w-0 opacity-0" aria-hidden name="website_url" />
          {c.consent && <label className="flex items-start gap-2 text-[12px] text-[#5b5b57]"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5" />I agree to be contacted by {form.organization} by phone, WhatsApp, SMS or email.</label>}
          {errors._ && <p className="text-[12.5px] text-[#cf3328]">{errors._}</p>}
          <button type="submit" disabled={busy} className="flex h-11 items-center justify-center gap-2 rounded-lg text-[14px] font-semibold text-white disabled:opacity-60" style={{ background: c.accent }}>{busy && <Loader2 className="size-4 animate-spin" />}{c.button}</button>
          <p className="text-center text-[10.5px] text-[#898984]">Your details go only to {form.organization}.</p>
        </form>
      )}
    </div>
  );
  if (embed) return <div data-theme="light" className="bg-white p-2">{card}</div>;
  return <div data-theme="light" className="flex min-h-screen items-center justify-center bg-[#f4f4f1] px-4 py-10">{card}</div>;
}
