'use client';
import { SetPasswordForm } from '../../password-form';

export function AcceptForm({ token, name }: { token: string; name: string }) {
  return <SetPasswordForm endpoint="/api/v1/auth/invitations/accept" extra={{ token }} withName defaultName={name} submitLabel="Activate account" onDone={(res) => {
    const n = (res as { welcomeLeads?: { count?: number } | null })?.welcomeLeads?.count ?? 0;
    const msg = n ? `Account activated — your ${n} free leads are ready. Sign in to see them.` : 'Account activated. Please sign in.';
    window.location.href = `/login?error=${encodeURIComponent(msg)}`;
  }} />;
}
