import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CaptureFormView } from '@/components/marketing/capture-form';
import { publicCaptureForm } from '@/server/services/capture';

export async function generateMetadata({ params }: PageProps<'/f/[slug]'>): Promise<Metadata> {
  const f = await publicCaptureForm((await params).slug);
  return f ? { title: `${f.config.title} · ${f.organization}`, description: f.config.description || undefined, robots: { index: false } } : { title: 'Form not found' };
}

/** Hosted lead-capture form. `?embed=1` renders just the card for iframes on the client's website. */
export default async function CapturePage({ params, searchParams }: PageProps<'/f/[slug]'>) {
  const f = await publicCaptureForm((await params).slug, { countView: true });
  if (!f) notFound();
  const embed = (await searchParams).embed === '1';
  return <CaptureFormView form={f} embed={embed} />;
}
