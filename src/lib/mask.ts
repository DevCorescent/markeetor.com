/** Display masking for sensitive contact fields. Masked values are produced server-side; raw values only leave the server through audited reveal endpoints. */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const [user, domain] = email.split('@');
  if (!domain) return '•••';
  return `${user.slice(0, 1)}${'•'.repeat(Math.max(2, Math.min(6, user.length - 1)))}@${domain}`;
}

export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '•••';
  const cc = phone.startsWith('+') ? `+${digits.slice(0, Math.min(2, digits.length - 6))} ` : '';
  return `${cc}••• ••• ${digits.slice(-4)}`;
}

export const SENSITIVE_FIELDS = ['email', 'phone', 'secondaryPhone'] as const;
export type SensitiveField = (typeof SENSITIVE_FIELDS)[number];
