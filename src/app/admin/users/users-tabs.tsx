'use client';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/overlay';
import { useUrlState } from '@/lib/hooks';
import { UsersPanel } from './users-panel';

export function UsersTabs({ canInvite }: { canInvite: boolean }) {
  const [s, set] = useUrlState({ tab: 'platform' });
  return (
    <>
      <Tabs value={s.tab} onValueChange={(v) => set({ tab: v })}>
        <TabsList className="mb-4">
          <TabsTrigger value="platform">Platform staff</TabsTrigger>
          <TabsTrigger value="all">All users</TabsTrigger>
        </TabsList>
      </Tabs>
      {s.tab === 'platform' ? <UsersPanel key="p" platformOnly canInvite={canInvite} /> : <UsersPanel key="a" canInvite={false} showOrg />}
    </>
  );
}
