import { redirect } from 'next/navigation';
import { withPlatform } from '@/server/db';
import { getSetting } from '@/server/settings';

/** `/join?ref=CODE` (referral links): the homepage sign-up form, or the newest published one. */
export default async function JoinIndex({ searchParams }: PageProps<'/join'>) {
  const ref = (await searchParams).ref;
  const code = typeof ref === 'string' && /^[A-Za-z0-9]{4,20}$/.test(ref) ? ref : null;
  const home = await getSetting('homepage');
  const homeForm = home.formId ? await withPlatform((tx) => tx.onboardingForm.findFirst({ where: { id: home.formId!, status: 'PUBLISHED' }, select: { slug: true } })) : null;
  const latest = homeForm ? null : await withPlatform((tx) => tx.onboardingForm.findFirst({ where: { status: 'PUBLISHED' }, orderBy: { updatedAt: 'desc' }, select: { slug: true } }));
  const slug = homeForm?.slug ?? latest?.slug;
  if (!slug) redirect(code ? `/?ref=${code}` : '/');
  redirect(`/join/${slug}${code ? `?ref=${code}` : ''}`);
}
