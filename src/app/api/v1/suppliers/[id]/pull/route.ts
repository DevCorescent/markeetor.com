import { idParam, route } from '@/server/api';
import { pullSupplierStock } from '@/server/services/suppliers';

/** Archive the supplier's unsold leads (they leave the marketplace). */
export const POST = route({ perm: 'marketplace.manage', stepUp: true }, async ({ ctx, params }) => pullSupplierStock(ctx, idParam(params)));
