import { idParam, route } from '@/server/api';
import { verifySmtpAccount } from '@/server/services/email';

export const POST = route({ scope: 'ANY', perm: ['email.manage', 'crm.email.manage'] }, async ({ ctx, params }) => verifySmtpAccount(ctx, idParam(params)));
