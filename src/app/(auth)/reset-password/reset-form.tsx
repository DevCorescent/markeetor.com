'use client';
import { SetPasswordForm } from '../password-form';

export function ResetForm({ token }: { token: string }) {
  return <SetPasswordForm endpoint="/api/v1/auth/password/reset" extra={{ token }} submitLabel="Update password" onDone={() => (window.location.href = '/login?error=Password%20updated.%20Please%20sign%20in.')} />;
}
