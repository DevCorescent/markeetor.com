import { financeSettingsSchema } from '@/lib/finance';
import { route } from '@/server/api';
import { getFinance, saveFinance } from '@/server/services/finance';
import { razorpayConfigured } from '@/server/services/payments';

export const GET = route({ perm: 'marketplace.manage' }, async () => ({ settings: await getFinance(), razorpay: { configured: razorpayConfigured(), webhook: Boolean(process.env.RAZORPAY_WEBHOOK_SECRET) } }));
export const PUT = route({ perm: 'marketplace.manage', stepUp: true, body: financeSettingsSchema }, async ({ ctx, body }) => ({ settings: await saveFinance(ctx, body) }));
