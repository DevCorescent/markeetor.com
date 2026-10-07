import { route } from '@/server/api';
import { onboardingStats } from '@/server/services/onboarding';

export const GET = route({ perm: 'onboarding.manage' }, async () => onboardingStats());
