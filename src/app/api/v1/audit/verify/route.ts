import { route } from '@/server/api';
import { verifyAuditChain } from '@/server/services/governance';

export const POST = route({ perm: 'audit.admin', rate: { bucket: 'audit-verify', limit: 10, windowSec: 3600 } }, async ({ ctx }) => verifyAuditChain(ctx));
