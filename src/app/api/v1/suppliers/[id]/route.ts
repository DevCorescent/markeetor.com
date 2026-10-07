import { idParam, route } from '@/server/api';
import { deleteSupplier, saveSupplier, supplierInput } from '@/server/services/suppliers';

export const PUT = route({ perm: 'marketplace.manage', body: supplierInput }, async ({ ctx, params, body }) => saveSupplier(ctx, idParam(params), body));
export const DELETE = route({ perm: 'marketplace.manage' }, async ({ ctx, params }) => deleteSupplier(ctx, idParam(params)));
