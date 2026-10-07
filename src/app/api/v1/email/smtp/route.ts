import { route } from '@/server/api';
import { listSmtpAccounts, saveSmtpAccount, smtpInput } from '@/server/services/email';

export const GET = route({ scope: 'ANY', perm: ['email.send', 'email.manage', 'crm.email.send', 'crm.email.manage'] }, async ({ ctx }) => ({ accounts: await listSmtpAccounts(ctx) }));
export const POST = route({ scope: 'ANY', perm: ['email.manage', 'crm.email.manage'], body: smtpInput, rate: { bucket: 'smtp-save', limit: 30, windowSec: 3600 } }, async ({ ctx, body }) => saveSmtpAccount(ctx, null, body));
